import { Router } from 'express';
import multer from 'multer';
import prisma from '../../db/prisma.js';
import whoami from '../../middlewares/whoami.js';
import { requirePermission } from '../../middlewares/requireBuildingPermission.js';
import { ok, fail } from '../../utils/respond.js';
import { isId } from '../../utils/ids.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import { editorWriteLimiter } from '../../services/rateLimiter.js';
import { uploadBuffer, deleteByUrl, keys, contentTypeFor } from '../../services/storage.js';
import { invalidate } from '../wayfinding/graphCache.js';
import { getGraph } from '../wayfinding/graphCache.js';
import { validateGraph } from './graphValidation.js';
import { normalizeDrawing } from './drawingSchema.js';
import { buildQrSlug } from '../qr/qrPayload.js';
import { createEdge, recomputeEdgesForNode, normalizePair, computeEdgeGeometry } from './edgeService.js';

const router = Router();

const NODE_TYPES = ['NORMAL', 'ENTRANCE', 'TRANSIT', 'POI', 'EMERGENCY_EXIT'];
const TRANSIT_TYPES = ['WALKWAY', 'ELEVATOR', 'ESCALATOR', 'STAIRS'];

const canEditMap = [whoami, requirePermission(PERMISSIONS.CAN_EDIT_MAP)];

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Only SVG, PNG, JPEG or WebP files are allowed'));
  },
});

/** Canvas bounds. The editor works in these units; metres are converted client
 *  side against scalePixelsPerMeter, so the server only guards sanity. */
const MIN_FLOOR_SIDE = 100;
const MAX_FLOOR_SIDE = 20000;

/**
 * Read the optional width/height pair off a floor body.
 *
 * Returns `{ width, height }` as `undefined` when absent so a PATCH that does
 * not mention them leaves the stored values alone.
 *
 * @param {Record<string, unknown>} body
 * @returns {{width?: number, height?: number, error?: string}}
 */
const readDimensions = (body) => {
  const out = {};
  for (const key of ['width', 'height']) {
    if (body[key] === undefined || body[key] === '') continue;
    const n = Number(body[key]);
    if (!Number.isFinite(n) || n < MIN_FLOOR_SIDE || n > MAX_FLOOR_SIDE) {
      return {
        error: `${key} must be between ${MIN_FLOOR_SIDE} and ${MAX_FLOOR_SIDE}.`,
      };
    }
    out[key] = Math.round(n);
  }
  return out;
};

// ---------------------------------------------------------------- floors ----

router.post(
  '/api/map-editor/buildings/:buildingId/floors',
  ...canEditMap,
  editorWriteLimiter,
  imageUpload.single('map'),
  async (req, res) => {
    try {
      const floorNumber = Number(req.body.floorNumber);
      if (!Number.isInteger(floorNumber) || floorNumber < 0) {
        return fail(res, 422, 'floorNumber must be a non-negative integer.');
      }
      const name = typeof req.body.name === 'string' ? req.body.name.trim() : null;
      const scale = req.body.scalePixelsPerMeter
        ? Number(req.body.scalePixelsPerMeter)
        : null;
      if (scale !== null && (!Number.isFinite(scale) || scale <= 0)) {
        return fail(res, 422, 'scalePixelsPerMeter must be a positive number.');
      }

      // Drawn floors carry their own canvas size (derived from the room
      // dimensions the user typed); uploaded ones inherit the default space.
      const dims = readDimensions(req.body);
      if (dims.error) return fail(res, 422, dims.error);

      const drawing = normalizeDrawing(req.body.drawing);
      if (!drawing.ok) return fail(res, 422, drawing.error);

      const floor = await prisma.floor.create({
        data: {
          buildingId: req.building.id,
          floorNumber,
          name: name || `Floor ${floorNumber}`,
          scalePixelsPerMeter: scale,
          width: dims.width,
          height: dims.height,
          drawing: drawing.drawing ?? undefined,
        },
      });

      let mapImageUrl = null;
      if (req.file) {
        const ext = req.file.mimetype === 'image/svg+xml' ? 'svg' : req.file.originalname.split('.').pop();
        mapImageUrl = await uploadBuffer({
          key: keys.floorMap(req.building.id, floor.id, ext),
          buffer: req.file.buffer,
          contentType: req.file.mimetype,
        });
        await prisma.floor.update({ where: { id: floor.id }, data: { mapImageUrl } });
      }

      invalidate(req.building.id);
      return ok(res, {
        status: 201,
        message: 'Floor created.',
        data: { floor: { ...floor, mapImageUrl } },
      });
    } catch (err) {
      if (err.code === 'P2002') {
        return fail(res, 409, 'That floor number already exists in this building.');
      }
      console.error('Create floor error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

router.get(
  '/api/map-editor/buildings/:buildingId/floors',
  ...canEditMap,
  async (req, res) => {
    try {
      const floors = await prisma.floor.findMany({
        where: { buildingId: req.building.id },
        orderBy: { floorNumber: 'asc' },
      });
      return ok(res, { data: { floors } });
    } catch (err) {
      console.error('List floors error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

router.patch(
  '/api/map-editor/floors/:floorId',
  ...canEditMap,
  editorWriteLimiter,
  imageUpload.single('map'),
  async (req, res) => {
    try {
      const floor = await prisma.floor.findFirst({
        where: { id: req.params.floorId, buildingId: req.building.id },
      });
      if (!floor) return fail(res, 404, 'Floor not found.');

      const data = {};
      if (req.body.name !== undefined) data.name = String(req.body.name).trim();
      if (req.body.floorNumber !== undefined) {
        const n = Number(req.body.floorNumber);
        if (!Number.isInteger(n) || n < 0) {
          return fail(res, 422, 'floorNumber must be a non-negative integer.');
        }
        data.floorNumber = n;
      }
      if (req.body.scalePixelsPerMeter !== undefined) {
        const s = Number(req.body.scalePixelsPerMeter);
        if (!Number.isFinite(s) || s <= 0) {
          return fail(res, 422, 'scalePixelsPerMeter must be a positive number.');
        }
        data.scalePixelsPerMeter = s;
      }
      if (typeof req.body.svgContent === 'string') {
        data.svgContent = req.body.svgContent;
      }

      const dims = readDimensions(req.body);
      if (dims.error) return fail(res, 422, dims.error);
      if (dims.width !== undefined) data.width = dims.width;
      if (dims.height !== undefined) data.height = dims.height;

      // Absent means "not part of this PATCH"; an explicit null clears it.
      if (req.body.drawing !== undefined) {
        const drawing = normalizeDrawing(req.body.drawing);
        if (!drawing.ok) return fail(res, 422, drawing.error);
        data.drawing = drawing.drawing;
      }

      if (req.file) {
        const ext = req.file.mimetype === 'image/svg+xml' ? 'svg' : req.file.originalname.split('.').pop();
        data.mapImageUrl = await uploadBuffer({
          key: keys.floorMap(req.building.id, floor.id, ext),
          buffer: req.file.buffer,
          contentType: req.file.mimetype,
        });
        if (floor.mapImageUrl) await deleteByUrl(floor.mapImageUrl).catch(() => {});
      }

      const updated = await prisma.floor.update({ where: { id: floor.id }, data });
      invalidate(req.building.id);
      return ok(res, { message: 'Floor updated.', data: { floor: updated } });
    } catch (err) {
      if (err.code === 'P2002') {
        return fail(res, 409, 'That floor number already exists in this building.');
      }
      console.error('Update floor error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

router.delete(
  '/api/map-editor/floors/:floorId',
  ...canEditMap,
  editorWriteLimiter,
  async (req, res) => {
    try {
      const floor = await prisma.floor.findFirst({
        where: { id: req.params.floorId, buildingId: req.building.id },
      });
      if (!floor) return fail(res, 404, 'Floor not found.');

      // FK cascade removes nodes; node cascade removes edges and POIs.
      await prisma.floor.delete({ where: { id: floor.id } });
      if (floor.mapImageUrl) await deleteByUrl(floor.mapImageUrl).catch(() => {});
      invalidate(req.building.id);
      return ok(res, { message: 'Floor deleted.' });
    } catch (err) {
      console.error('Delete floor error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

// ------------------------------------------------------------ shop logos ----

/**
 * POST /api/map-editor/buildings/:buildingId/logos
 *
 * Stores a shop logo and hands back its public URL, which the editor then
 * writes into the shape's `logoUrl`. Kept building-scoped (rather than on the
 * generic /api/upload router) so it inherits CAN_EDIT_MAP and the per-building
 * key prefix instead of letting any authenticated user fill the bucket.
 */
router.post(
  '/api/map-editor/buildings/:buildingId/logos',
  ...canEditMap,
  editorWriteLimiter,
  imageUpload.single('logo'),
  async (req, res) => {
    try {
      if (!req.file) return fail(res, 400, 'No logo uploaded.');

      const ext =
        req.file.mimetype === 'image/svg+xml'
          ? 'svg'
          : (req.file.originalname.split('.').pop() || 'png').toLowerCase();

      const url = await uploadBuffer({
        key: keys.shopLogo(req.building.id, ext),
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
      });

      return ok(res, { status: 201, message: 'Logo uploaded.', data: { url } });
    } catch (err) {
      console.error('Upload logo error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

// ----------------------------------------------------------------- nodes ----

router.post(
  '/api/map-editor/floors/:floorId/nodes',
  ...canEditMap,
  editorWriteLimiter,
  async (req, res) => {
    try {
      const floor = await prisma.floor.findFirst({
        where: { id: req.params.floorId, buildingId: req.building.id },
      });
      if (!floor) return fail(res, 404, 'Floor not found.');

      const { x, y, type = 'NORMAL', label } = req.body || {};
      if (typeof x !== 'number' || typeof y !== 'number' || Number.isNaN(x) || Number.isNaN(y)) {
        return fail(res, 422, 'x and y must be numbers.');
      }
      if (!NODE_TYPES.includes(type)) {
        return fail(res, 422, `type must be one of ${NODE_TYPES.join(', ')}.`);
      }

      const created = await prisma.node.create({
        data: {
          buildingId: req.building.id,
          floorId: floor.id,
          x,
          y,
          type,
          label: typeof label === 'string' ? label.trim().slice(0, 120) || null : null,
        },
      });

      // Every node is scannable from the moment it exists.
      //
      // The slug is a pure function of (building, floor, node), but it used to
      // be written only when someone opened the QR dialog — so a node could
      // sit in the graph with no printable identity, and the editor had no way
      // to show which points were ready to label. It needs the generated id,
      // hence the follow-up update rather than a value passed to create().
      let node = created;
      try {
        node = await prisma.node.update({
          where: { id: created.id },
          data: { qrSlug: buildQrSlug(req.building.id, floor.floorNumber, created.id) },
        });
      } catch (slugErr) {
        // A node without a slug still routes; the QR route regenerates it on
        // demand. Losing the whole node over this would be the worse trade.
        console.error('Node qrSlug assignment failed:', slugErr);
      }

      invalidate(req.building.id);
      return ok(res, { status: 201, message: 'Node created.', data: { node } });
    } catch (err) {
      console.error('Create node error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

router.patch(
  '/api/map-editor/nodes/:nodeId',
  ...canEditMap,
  editorWriteLimiter,
  async (req, res) => {
    try {
      const node = await prisma.node.findFirst({
        where: { id: req.params.nodeId, buildingId: req.building.id },
      });
      if (!node) return fail(res, 404, 'Node not found.');

      const data = {};
      const { x, y, type, label } = req.body || {};
      if (x !== undefined) {
        if (typeof x !== 'number' || Number.isNaN(x)) return fail(res, 422, 'x must be a number.');
        data.x = x;
      }
      if (y !== undefined) {
        if (typeof y !== 'number' || Number.isNaN(y)) return fail(res, 422, 'y must be a number.');
        data.y = y;
      }
      if (type !== undefined) {
        if (!NODE_TYPES.includes(type)) {
          return fail(res, 422, `type must be one of ${NODE_TYPES.join(', ')}.`);
        }
        data.type = type;
      }
      if (label !== undefined) {
        data.label =
          typeof label === 'string' ? label.trim().slice(0, 120) || null : null;
      }

      const updated = await prisma.node.update({ where: { id: node.id }, data });
      if (data.x !== undefined || data.y !== undefined) {
        await recomputeEdgesForNode(node.id);
      }
      invalidate(req.building.id);
      return ok(res, { message: 'Node updated.', data: { node: updated } });
    } catch (err) {
      console.error('Update node error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

router.delete(
  '/api/map-editor/nodes/:nodeId',
  ...canEditMap,
  editorWriteLimiter,
  async (req, res) => {
    try {
      const deleted = await prisma.node.deleteMany({
        where: { id: req.params.nodeId, buildingId: req.building.id },
      });
      if (deleted.count === 0) return fail(res, 404, 'Node not found.');
      invalidate(req.building.id);
      return ok(res, { message: 'Node deleted.' });
    } catch (err) {
      console.error('Delete node error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

// ----------------------------------------------------------------- edges ----

router.post(
  '/api/map-editor/edges',
  ...canEditMap,
  editorWriteLimiter,
  async (req, res) => {
    try {
      const { sourceNodeId, targetNodeId, transitType = 'WALKWAY', weight, accessible } = req.body || {};
      if (!isId(String(sourceNodeId)) || !isId(String(targetNodeId))) {
        return fail(res, 422, 'sourceNodeId and targetNodeId are required.');
      }
      if (!TRANSIT_TYPES.includes(transitType)) {
        return fail(res, 422, `transitType must be one of ${TRANSIT_TYPES.join(', ')}.`);
      }
      if (weight !== undefined && (typeof weight !== 'number' || weight <= 0)) {
        return fail(res, 422, 'weight must be a positive number.');
      }

      // Ownership: both nodes must be in the actor's building.
      const count = await prisma.node.count({
        where: { id: { in: [sourceNodeId, targetNodeId] }, buildingId: req.building.id },
      });
      if (count !== 2) return fail(res, 404, 'Both nodes must be in this building.');

      const edge = await createEdge({
        sourceNodeId,
        targetNodeId,
        transitType,
        weight: weight ?? null,
        accessible: typeof accessible === 'boolean' ? accessible : null,
      });
      invalidate(req.building.id);
      return ok(res, { status: 201, message: 'Edge created.', data: { edge } });
    } catch (err) {
      if (err.status) return fail(res, err.status, err.message);
      console.error('Create edge error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

router.patch(
  '/api/map-editor/edges/:edgeId',
  ...canEditMap,
  editorWriteLimiter,
  async (req, res) => {
    try {
      const edge = await prisma.edge.findFirst({
        where: { id: req.params.edgeId, buildingId: req.building.id },
        include: { source: true, target: true },
      });
      if (!edge) return fail(res, 404, 'Edge not found.');

      const data = {};
      const { transitType, weight, accessible } = req.body || {};
      if (transitType !== undefined) {
        if (!TRANSIT_TYPES.includes(transitType)) {
          return fail(res, 422, `transitType must be one of ${TRANSIT_TYPES.join(', ')}.`);
        }
        data.transitType = transitType;
      }
      if (accessible !== undefined) {
        if (typeof accessible !== 'boolean') return fail(res, 422, 'accessible must be a boolean.');
        data.accessible = accessible;
      }
      if (weight !== undefined) {
        if (weight !== null && (typeof weight !== 'number' || weight <= 0)) {
          return fail(res, 422, 'weight must be a positive number or null to reset.');
        }
        if (weight === null) {
          const { weight: computed } = computeEdgeGeometry(edge.source, edge.target, {
            transitType: data.transitType || edge.transitType,
          });
          data.weight = computed;
        } else {
          data.weight = weight;
        }
      } else if (data.transitType && edge.source.floorId !== edge.target.floorId) {
        // Transit type changed on a cross-floor edge whose weight tracked the
        // default: keep tracking the new default.
        const { weight: oldDefault } = computeEdgeGeometry(edge.source, edge.target, {
          transitType: edge.transitType,
        });
        if (Math.abs(edge.weight - oldDefault) < 1e-6) {
          const { weight: newDefault } = computeEdgeGeometry(edge.source, edge.target, {
            transitType: data.transitType,
          });
          data.weight = newDefault;
        }
      }

      const updated = await prisma.edge.update({ where: { id: edge.id }, data });
      invalidate(req.building.id);
      return ok(res, { message: 'Edge updated.', data: { edge: updated } });
    } catch (err) {
      console.error('Update edge error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

router.delete(
  '/api/map-editor/edges/:edgeId',
  ...canEditMap,
  editorWriteLimiter,
  async (req, res) => {
    try {
      const deleted = await prisma.edge.deleteMany({
        where: { id: req.params.edgeId, buildingId: req.building.id },
      });
      if (deleted.count === 0) return fail(res, 404, 'Edge not found.');
      invalidate(req.building.id);
      return ok(res, { message: 'Edge deleted.' });
    } catch (err) {
      console.error('Delete edge error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

// Vertical transit linker — sugar over edge creation with cross-floor checks.
router.post(
  '/api/map-editor/transit-links',
  ...canEditMap,
  editorWriteLimiter,
  async (req, res) => {
    try {
      const { nodeIds, transitType = 'STAIRS', accessible } = req.body || {};
      if (!Array.isArray(nodeIds) || nodeIds.length !== 2) {
        return fail(res, 422, 'nodeIds must be an array of exactly two node ids.');
      }
      if (!['STAIRS', 'ELEVATOR', 'ESCALATOR'].includes(transitType)) {
        return fail(res, 422, 'transitType must be STAIRS, ELEVATOR or ESCALATOR.');
      }

      const nodes = await prisma.node.findMany({
        where: { id: { in: nodeIds }, buildingId: req.building.id },
      });
      if (nodes.length !== 2) return fail(res, 404, 'Both nodes must be in this building.');
      if (nodes[0].floorId === nodes[1].floorId) {
        return fail(res, 422, 'Transit links connect nodes on different floors.');
      }

      const edge = await createEdge({
        sourceNodeId: nodeIds[0],
        targetNodeId: nodeIds[1],
        transitType,
        accessible: typeof accessible === 'boolean' ? accessible : null,
      });
      invalidate(req.building.id);
      return ok(res, { status: 201, message: 'Floors linked.', data: { edge } });
    } catch (err) {
      if (err.status) return fail(res, err.status, err.message);
      console.error('Transit link error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

// ------------------------------------------------------------------- POI ----

router.put(
  '/api/map-editor/nodes/:nodeId/poi',
  ...canEditMap,
  editorWriteLimiter,
  async (req, res) => {
    try {
      const node = await prisma.node.findFirst({
        where: { id: req.params.nodeId, buildingId: req.building.id },
      });
      if (!node) return fail(res, 404, 'Node not found.');

      const { name, category, description, keywords } = req.body || {};
      if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 120) {
        return fail(res, 422, 'name is required (1-120 characters).');
      }
      if (keywords !== undefined && (!Array.isArray(keywords) || keywords.some((k) => typeof k !== 'string'))) {
        return fail(res, 422, 'keywords must be an array of strings.');
      }

      const cleanKeywords = [
        ...new Set((keywords || []).map((k) => k.trim().toLowerCase()).filter(Boolean)),
      ].slice(0, 20);

      const poi = await prisma.$transaction(async (tx) => {
        const upserted = await tx.poi.upsert({
          where: { nodeId: node.id },
          create: {
            nodeId: node.id,
            name: name.trim(),
            category: typeof category === 'string' ? category.trim() || null : null,
            description:
              typeof description === 'string' ? description.trim().slice(0, 1000) || null : null,
            keywords: cleanKeywords,
          },
          update: {
            name: name.trim(),
            category: typeof category === 'string' ? category.trim() || null : null,
            description:
              typeof description === 'string' ? description.trim().slice(0, 1000) || null : null,
            keywords: cleanKeywords,
          },
        });
        if (node.type !== 'POI') {
          await tx.node.update({ where: { id: node.id }, data: { type: 'POI' } });
        }
        return upserted;
      });

      invalidate(req.building.id);
      return ok(res, { message: 'POI saved.', data: { poi } });
    } catch (err) {
      console.error('Upsert POI error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

router.delete(
  '/api/map-editor/nodes/:nodeId/poi',
  ...canEditMap,
  editorWriteLimiter,
  async (req, res) => {
    try {
      const node = await prisma.node.findFirst({
        where: { id: req.params.nodeId, buildingId: req.building.id },
      });
      if (!node) return fail(res, 404, 'Node not found.');

      await prisma.$transaction(async (tx) => {
        await tx.poi.deleteMany({ where: { nodeId: node.id } });
        if (node.type === 'POI') {
          await tx.node.update({ where: { id: node.id }, data: { type: 'NORMAL' } });
        }
      });
      invalidate(req.building.id);
      return ok(res, { message: 'POI removed.' });
    } catch (err) {
      console.error('Delete POI error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

// ------------------------------------------------------- graph & validate ---

router.get(
  '/api/map-editor/buildings/:buildingId/graph',
  ...canEditMap,
  async (req, res) => {
    try {
      const [floors, nodes, edges, pois] = await Promise.all([
        prisma.floor.findMany({
          where: { buildingId: req.building.id },
          orderBy: { floorNumber: 'asc' },
        }),
        prisma.node.findMany({ where: { buildingId: req.building.id } }),
        prisma.edge.findMany({ where: { buildingId: req.building.id } }),
        prisma.poi.findMany({
          where: { node: { buildingId: req.building.id } },
        }),
      ]);
      return ok(res, { data: { floors, nodes, edges, pois } });
    } catch (err) {
      console.error('Editor graph error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

router.get(
  '/api/map-editor/buildings/:buildingId/validate',
  ...canEditMap,
  async (req, res) => {
    try {
      invalidate(req.building.id); // validate against fresh data
      const graph = await getGraph(req.building.id);
      const result = validateGraph(graph);
      return ok(res, { data: result });
    } catch (err) {
      console.error('Validate graph error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

export default router;
