import express from 'express';
import { buildingLimitFor, floorLimitFor } from '../../services/plans.js';
import QRCode from 'qrcode';
import jwt from 'jsonwebtoken';
import { Filter } from 'bad-words';
import prisma from '../../db/prisma.js';
import config from '../../config/index.js';
import upload, { imageExtFor } from '../../middlewares/buildingUpload.js';
import whoami from '../../middlewares/whoami.js';
import {
  requireOwner,
  requirePermission,
} from '../../middlewares/requireBuildingPermission.js';
import { PERMISSIONS, SYSTEM_ROLES } from '../../auth/permissions.js';
import { isId } from '../../utils/ids.js';
import { uploadBuffer, deleteByUrl, keys } from '../../services/storage.js';
import { displayName } from '../../services/displayName.js';
import { publicReadLimiter } from '../../services/rateLimiter.js';
import { publish } from '../../features/realtime/broadcaster.js';
import { invalidate } from '../../features/wayfinding/graphCache.js';

const router = express.Router();

/* ---------------- HELPERS ---------------- */

// LEGACY COMPATIBILITY: the deployed frontend reads `buildingName`, `owner`,
// `maps[]` ({floor, map, qrCode, scanned, createdAt}) and `Message`/`Success`
// envelopes on these routes. The Prisma columns are name/ownerId/Floor rows —
// everything below synthesizes the old shape from the new tables.

/** Legacy maps[] entry synthesized from a Floor row. */
export const legacyMapEntry = (floor) => ({
  floor: floor.name || String(floor.floorNumber),
  map: floor.mapImageUrl,
  qrCode: floor.qrCodeUrl,
  scanned: floor.scanCount,
  createdAt: floor.createdAt,
});

/**
 * Legacy building document synthesized from a Building row plus its Floor
 * rows (ordered by floorNumber).
 */
export const legacyBuilding = (building, floors = []) => ({
  _id: building.id,
  id: building.id,
  buildingName: building.name,
  owner: building.ownerId,
  floors: floors.length,
  maps: floors.map(legacyMapEntry),
  globalScans: [],
  emergencyMode: building.emergencyMode,
  isDeactivated: building.isDeactivated,
  createdAt: building.createdAt,
  updatedAt: building.updatedAt,
});

/** The URL a floor QR encodes — same shape the printed codes already use. */
const floorQrDataUrl = (buildingId, floorName) =>
  QRCode.toDataURL(
    `${config.urls.appBase.replace(/\/+$/, '')}/building/${buildingId}/${encodeURIComponent(floorName)}`
  );

// Check building name validity
const checkBuildingName = async (userId, buildingName, buildingId = null) => {
  if (!userId || !buildingName || typeof buildingName !== 'string')
    return 'Something went wrong.';

  buildingName = buildingName.trim();
  if (buildingName.length < 4 || buildingName.length > 40)
    return 'Building name must have from 4 to 40 characters.';

  const filter = new Filter();
  if (filter.isProfane(buildingName)) return 'Building name contains bad words.';

  const exists = await prisma.building.findFirst({
    where: {
      ownerId: userId,
      name: buildingName,
      ...(buildingId ? { NOT: { id: buildingId } } : {}),
    },
    select: { id: true },
  });
  if (exists) return 'Building name already exists in your buildings.';

  return true;
};

/**
 * Coerce the floorNames field to an array of trimmed strings.
 *
 * In a multipart request a field sent exactly once arrives as a bare string,
 * not a one-element array, so single-floor buildings were rejected outright
 * unless the client happened to use `floorNames[]` bracket notation.
 */
const normalizeFloorNames = (floorNames) => {
  if (floorNames === undefined || floorNames === null) return [];
  const list = Array.isArray(floorNames) ? floorNames : [floorNames];
  return list.filter((f) => typeof f === 'string').map((f) => f.trim()).filter(Boolean);
};

/** Best-effort S3 cleanup — never lets a failed delete break the request. */
const deleteAssetQuietly = async (url) => {
  if (!url) return;
  try {
    await deleteByUrl(url);
  } catch (err) {
    console.error('Asset cleanup failed:', err.message);
  }
};

/* ---------------- CREATE BUILDING ---------------- */
router.post('/api/building/new', whoami, upload.array('maps'), async (req, res) => {
  try {
    if (req.user.verified === false)
      return res.send({ Success: false, Message: 'Verify account first.' });

    // Capacity per plan: the free tier maps one building end to end; paid
    // tiers scale out. Floors are capped separately at floor creation.
    const [ownedCount, planLimits] = await Promise.all([
      prisma.building.count({ where: { ownerId: req.user.id } }),
      Promise.resolve(buildingLimitFor(req.user.plan)),
    ]);
    if (ownedCount >= planLimits) {
      return res.send({
        Success: false,
        Message: `Your plan allows up to ${planLimits} building${planLimits === 1 ? '' : 's'}. Upgrade to add more.`,
      });
    }

    // Plan floor cap applies to the floors created with the building too.
    const floorCap = floorLimitFor(req.user.plan);

    const { buildingName } = req.body;
    if (!buildingName || typeof buildingName !== 'string')
      return res.send({ Success: false, Message: 'Invalid building name.' });

    const floorNames = normalizeFloorNames(req.body.floorNames);
    if (floorNames.length === 0)
      return res.send({ Success: false, Message: 'Invalid floor names.' });

    if (floorNames.length > floorCap) {
      return res.send({
        Success: false,
        Message: `Your plan allows up to ${floorCap} floors per building. Upgrade to add more.`,
      });
    }

    const normalizedFloors = floorNames.map((f) => f.toLowerCase());
    if (new Set(normalizedFloors).size !== normalizedFloors.length)
      return res.send({ Success: false, Message: 'Floor names must be unique.' });

    const nameCheck = await checkBuildingName(req.user.id, buildingName);
    if (nameCheck !== true) return res.send({ Success: false, Message: nameCheck });

    const files = req.files || [];
    if (files.length > floorNames.length)
      return res.send({ Success: false, Message: 'Too many map files uploaded.' });

    // Building + its four system roles in one transaction: RBAC on a building
    // without roles cannot delegate anything, so they are inseparable.
    const building = await prisma.building.create({
      data: {
        name: buildingName.trim(),
        ownerId: req.user.id,
        roles: {
          create: SYSTEM_ROLES.map((role) => ({
            name: role.name,
            permissions: [...role.permissions],
            isSystem: true,
          })),
        },
      },
    });

    for (let i = 0; i < floorNames.length; i++) {
      const floorName = floorNames[i];
      const floor = await prisma.floor.create({
        data: {
          buildingId: building.id,
          floorNumber: i + 1,
          name: floorName,
          qrCodeUrl: await floorQrDataUrl(building.id, floorName),
        },
      });

      const file = files[i];
      if (file) {
        try {
          const ext = imageExtFor(file.mimetype) || 'bin';
          const mapUrl = await uploadBuffer({
            key: keys.floorMap(building.id, floor.id, ext),
            buffer: file.buffer,
            contentType: file.mimetype,
          });
          await prisma.floor.update({
            where: { id: floor.id },
            data: { mapImageUrl: mapUrl },
          });
        } catch (error) {
          // Same policy as the Cloudinary era: a failed upload leaves the map
          // null rather than failing the whole creation.
          console.error(`Failed to upload floor ${floorName} map:`, error);
        }
      }
    }

    return res.send({
      Success: true,
      Message: 'Building created successfully.',
      buildingID: building.id,
    });
  } catch (error) {
    console.error(error);
    return res.send({ Success: false, Message: 'Server error.' });
  }
});

/* ---------------- UPDATE BUILDING (replace floors/maps) ---------------- */
router.put('/api/building/:id', whoami, requireOwner, upload.array('maps'), async (req, res) => {
  try {
    const building = req.building;

    let { buildingName, floorNames } = req.body;
    floorNames = normalizeFloorNames(floorNames);

    const nameCheck = await checkBuildingName(req.user.id, buildingName, building.id);
    if (nameCheck !== true) return res.send({ Success: false, Message: nameCheck });

    const normalizedFloors = floorNames.map((f) => f.toLowerCase());
    if (floorNames.length === 0 || new Set(normalizedFloors).size !== normalizedFloors.length)
      return res.send({ Success: false, Message: 'Floor names must be unique.' });

    const files = req.files || [];
    if (files.length !== floorNames.length)
      return res.send({ Success: false, Message: 'Each floor must have one map.' });

    // Reconcile against Floor rows. Floors are matched by name (legacy maps[]
    // preserved scan counts by floor name), unmatched floors are deleted
    // (their nodes cascade), and the survivors are renumbered by position.
    const existing = await prisma.floor.findMany({ where: { buildingId: building.id } });
    const byName = new Map(existing.map((f) => [f.name || String(f.floorNumber), f]));

    const plans = floorNames.map((name, index) => ({
      name,
      index,
      row: byName.get(name) || null,
    }));

    const keepIds = plans.filter((p) => p.row).map((p) => p.row.id);
    const dropped = existing.filter((f) => !keepIds.includes(f.id));
    await prisma.floor.deleteMany({
      where: { buildingId: building.id, id: { notIn: keepIds } },
    });
    for (const f of dropped) await deleteAssetQuietly(f.mapImageUrl);

    // Two-phase renumbering keeps @@unique(buildingId, floorNumber) happy
    // while floors move positions.
    await prisma.$transaction(
      plans
        .filter((p) => p.row)
        .map((p) =>
          prisma.floor.update({
            where: { id: p.row.id },
            data: { floorNumber: -(p.index + 1) },
          })
        )
    );
    for (const p of plans) {
      if (!p.row) {
        p.row = await prisma.floor.create({
          data: { buildingId: building.id, floorNumber: -(p.index + 1), name: p.name },
        });
      }
    }

    for (const p of plans) {
      let mapUrl = null;
      const file = files[p.index];
      if (file) {
        try {
          const ext = imageExtFor(file.mimetype) || 'bin';
          mapUrl = await uploadBuffer({
            key: keys.floorMap(building.id, p.row.id, ext),
            buffer: file.buffer,
            contentType: file.mimetype,
          });
        } catch (error) {
          console.error(`Failed to upload floor ${p.name} map:`, error);
          mapUrl = null;
        }
      }
      if (mapUrl) await deleteAssetQuietly(p.row.mapImageUrl);

      await prisma.floor.update({
        where: { id: p.row.id },
        data: {
          floorNumber: p.index + 1,
          name: p.name,
          mapImageUrl: mapUrl,
          // Same URL shape the create route uses — building id + floor name.
          qrCodeUrl: await floorQrDataUrl(building.id, p.name),
        },
      });
    }

    await prisma.building.update({
      where: { id: building.id },
      data: { name: buildingName.trim() },
    });
    invalidate(building.id);

    res.send({ Success: true, Message: 'Building updated.' });
  } catch (error) {
    console.error(error);
    res.status(500).send({ Success: false, Message: 'Server error.' });
  }
});

/* ---------------- GET BUILDING BY ID ---------------- */
// Public on purpose: an occupant scanning a QR has no account, and the
// frontend BuildingOwnerGuard compares `Message.owner` against the current
// user id. So the building stays readable, but the owner is reduced to an id
// plus a display name — never their email, phone, or scan history.
router.get('/api/building/id/:buildingID', async (req, res) => {
  const { buildingID } = req.params;

  try {
    if (!buildingID || !isId(buildingID)) {
      return res.send({ Success: false, Message: 'Invalid building ID.' });
    }

    const building = await prisma.building.findUnique({
      where: { id: buildingID },
      include: {
        floors: { orderBy: { floorNumber: 'asc' } },
        owner: { select: { id: true, name: true, lastname: true, company: true, userType: true } },
      },
    });
    if (!building) return res.send({ Success: false, Message: 'Building not found.' });
    if (!building.owner) return res.send({ Success: false, Message: 'Owner data missing.' });

    return res.send({
      Success: true,
      Message: legacyBuilding(building, building.floors),
      Owner: {
        _id: building.owner.id,
        displayName: displayName(building.owner),
        userType: building.owner.userType,
      },
    });
  } catch (error) {
    console.error('GET /api/building/id/:buildingID error:', error);
    return res.send({ Success: false, Message: 'Server error.' });
  }
});

/* ---------------- GET MY BUILDINGS ---------------- */
router.get('/api/building/my', whoami, async (req, res) => {
  try {
    const owned = await prisma.building.findMany({
      where: { ownerId: req.user.id },
      include: { floors: { orderBy: { floorNumber: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });

    // Additive: buildings the user belongs to through a role (RBAC). The
    // deployed frontend ignores unknown fields, so this is non-breaking.
    const memberships = await prisma.buildingMember.findMany({
      where: { userId: req.user.id },
      include: {
        building: { include: { floors: { orderBy: { floorNumber: 'asc' } } } },
        role: { select: { name: true, permissions: true } },
      },
    });

    return res.send({
      Success: true,
      Message: owned.map((b) => legacyBuilding(b, b.floors)),
      memberBuildings: memberships.map((m) => ({
        ...legacyBuilding(m.building, m.building.floors),
        role: m.role.name,
        permissions: m.role.permissions,
      })),
    });
  } catch (err) {
    console.error(err);
    return res.send({ Success: false, Message: 'Server error' });
  }
});

/* ---------------- SCAN FLOOR (legacy scheme B: floor by NAME) ---------------- */
router.get('/api/building/scan/:id/:floor', publicReadLimiter, async (req, res) => {
  const { id, floor } = req.params;
  try {
    if (!id || !isId(id))
      return res.status(400).send({ Success: false, Message: 'Invalid building id.' });

    const building = await prisma.building.findUnique({
      where: { id },
      include: { floors: { orderBy: { floorNumber: 'asc' } } },
    });
    if (!building)
      return res.status(404).send({ Success: false, Message: 'Building not found.' });

    // A deactivated building is honored rather than silently switched back on.
    // This endpoint is anonymous, so reactivating here would let any passer-by
    // undo the owner-only deactivation and get served stale evacuation data.
    if (building.isDeactivated) {
      return res.status(410).send({ Success: false, Message: 'This building is currently deactivated.' });
    }

    // The printed floor QR carries the floor NAME. Resolve by name first, then
    // by number, then fall back to the first floor (old maps[0] fallback).
    let floorRow =
      building.floors.find((f) => (f.name || String(f.floorNumber)) === floor) || null;
    if (!floorRow) {
      const parsed = parseInt(floor, 10);
      if (!Number.isNaN(parsed)) {
        floorRow = building.floors.find((f) => f.floorNumber === parsed) || null;
      }
    }
    if (!floorRow) floorRow = building.floors[0] || null;
    if (!floorRow)
      return res.status(404).send({ Success: false, Message: 'Floor not found.' });

    const updatedFloor = await prisma.floor.update({
      where: { id: floorRow.id },
      data: { scanCount: { increment: 1 } },
    });

    if (building.emergencyMode === true) {
      try {
        const message = 'Floor QR has been scanned.';
        await prisma.$transaction([
          prisma.log.create({
            data: { buildingId: building.id, type: 'SCAN', isEmergency: true, message },
          }),
          prisma.emergencyEvent.updateMany({
            where: { buildingId: building.id, status: 'ACTIVE' },
            data: { scanned: { increment: 1 } },
          }),
        ]);
        publish(building.id, 'log_appended', {
          message,
          type: 'SCAN',
          createdAt: new Date().toISOString(),
        });
      } catch (logErr) {
        console.error('Failed to record emergency scan:', logErr.message);
      }
    }

    // Same reasoning as the QR scan route: an invalid token must not turn a
    // successful floor lookup into a 500 for the person standing in the building.
    const userToken = req.cookies['userToken'];
    if (userToken) {
      try {
        const decoded = jwt.verify(userToken, config.jwt.secret);
        if (decoded?.userID) {
          await prisma.scanEvent.create({
            data: {
              buildingId: building.id,
              userId: decoded.userID,
              buildingName: building.name,
            },
          });
        }
      } catch (tokenErr) {
        console.warn('Scan history not recorded (invalid token):', tokenErr.message);
      }
    }

    const floorData = legacyMapEntry(updatedFloor);
    return res.send({
      Success: true,
      Message: {
        buildingName: building.name,
        floorData,
        scannedCount: updatedFloor.scanCount,
      },
    });
  } catch (error) {
    console.error('GET /api/building/scan/:id/:floor error:', error);
    return res.status(500).send({ Success: false, Message: 'Server error.' });
  }
});

/* ---------------- DELETE BUILDING ---------------- */
router.delete('/api/building/delete/:buildingId', whoami, requireOwner, async (req, res) => {
  try {
    const building = req.building;

    // Counts reported to the client, gathered before the cascade removes them.
    const [nodeCount, floors] = await Promise.all([
      prisma.node.count({ where: { buildingId: building.id } }),
      prisma.floor.findMany({
        where: { buildingId: building.id },
        select: { id: true, mapImageUrl: true },
      }),
    ]);

    // FK cascades replace the manual multi-collection cleanup: floors, nodes,
    // edges, roles, members, invites, logs, emergencies and scan events all go
    // with the building row.
    await prisma.building.delete({ where: { id: building.id } });
    invalidate(building.id);

    // Best-effort S3/Cloudinary cleanup — data is already gone, assets are
    // just storage cost, so failures are logged and ignored.
    for (const f of floors) await deleteAssetQuietly(f.mapImageUrl);

    return res.send({
      Success: true,
      Message: 'Building and all related data deleted successfully.',
      DeletedCounts: {
        nodes: nodeCount,
        floors: floors.length,
      },
    });
  } catch (err) {
    console.error('Delete Error:', err);
    return res.status(500).send({ Success: false, Message: 'Server error.' });
  }
});

/* ---------------- DELETE FLOOR ---------------- */
router.delete(
  '/api/building/:buildingId/floor/:floorNumber',
  whoami,
  requirePermission(PERMISSIONS.CAN_EDIT_MAP),
  async (req, res) => {
    const floorNum = parseInt(req.params.floorNumber, 10);
    if (Number.isNaN(floorNum) || floorNum < 1) {
      return res.status(400).send({ Success: false, Message: 'Invalid floor number.' });
    }

    try {
      // Floor rows have stable identity now — deleting floor 2 no longer
      // renumbers floor 3, so nodes and QR codes on other floors stay valid.
      const floor = await prisma.floor.findUnique({
        where: {
          buildingId_floorNumber: { buildingId: req.building.id, floorNumber: floorNum },
        },
      });

      let nodeCount = 0;
      let floorDeleted = 0;
      if (floor) {
        nodeCount = await prisma.node.count({ where: { floorId: floor.id } });
        await prisma.floor.delete({ where: { id: floor.id } }); // cascades nodes/edges
        floorDeleted = 1;
        await deleteAssetQuietly(floor.mapImageUrl);
        invalidate(req.building.id);
      }

      return res.send({
        Success: true,
        Message: 'Floor and all related data deleted successfully.',
        DeletedCounts: {
          nodes: nodeCount,
          floorMap: floorDeleted,
        },
      });
    } catch (err) {
      console.error('Floor Delete Error:', err);
      return res.status(500).send({ Success: false, Message: 'Server error.' });
    }
  }
);

/* ---------------- UPDATE FLOOR MAP ---------------- */
router.put(
  '/api/building/:buildingId/floor/:floorNumber/map',
  whoami,
  requirePermission(PERMISSIONS.CAN_EDIT_MAP),
  async (req, res) => {
    try {
      const { svgContent, svgMapUrl, width, height } = req.body;

      const floorNum = parseInt(req.params.floorNumber, 10);
      if (Number.isNaN(floorNum) || floorNum < 1) {
        return res.status(400).json({ Success: false, Message: 'Invalid floor number.' });
      }

      // The row must exist (or be created) before the upload so the S3 key can
      // embed the floor id.
      const floor = await prisma.floor.upsert({
        where: {
          buildingId_floorNumber: { buildingId: req.building.id, floorNumber: floorNum },
        },
        create: { buildingId: req.building.id, floorNumber: floorNum },
        update: {},
      });

      let mapUrl = typeof svgMapUrl === 'string' && svgMapUrl ? svgMapUrl : null;

      if (svgContent && typeof svgContent === 'string') {
        try {
          mapUrl = await uploadBuffer({
            key: keys.floorMap(req.building.id, floor.id, 'svg'),
            buffer: Buffer.from(svgContent),
            contentType: 'image/svg+xml',
          });
        } catch (uploadError) {
          console.error('Floor SVG upload failed:', uploadError);
          return res.status(500).json({
            Success: false,
            Message: 'Failed to upload SVG',
          });
        }
      }

      // A floor map needs a resolvable URL — a request carrying neither
      // svgContent nor svgMapUrl would store an unrenderable floor.
      if (!mapUrl) {
        return res.status(400).json({
          Success: false,
          Message: 'A floor map requires either svgContent or svgMapUrl.',
        });
      }

      const mapWidth = parseInt(width) || 1000;
      const mapHeight = parseInt(height) || 800;

      await prisma.floor.update({
        where: { id: floor.id },
        data: {
          svgContent: typeof svgContent === 'string' ? svgContent : null,
          mapImageUrl: mapUrl,
          width: mapWidth,
          height: mapHeight,
        },
      });

      return res.json({
        Success: true,
        Message: 'Floor map updated successfully.',
        Data: {
          floorNumber: floorNum,
          mapUrl,
          width: mapWidth,
          height: mapHeight,
        },
      });
    } catch (error) {
      console.error('Error updating floor map:', error);
      return res.status(500).json({
        Success: false,
        Message: 'Server error while updating floor map.',
      });
    }
  }
);

/* ---------------- DEACTIVATE BUILDING ---------------- */
router.put('/api/building/deactivate/:id', whoami, requireOwner, async (req, res) => {
  try {
    const building = await prisma.building.update({
      where: { id: req.building.id },
      data: { isDeactivated: true },
    });

    if (building.emergencyMode === true) {
      await prisma.log.create({
        data: {
          buildingId: building.id,
          type: 'SYSTEM',
          message: 'Building has been deactivated.',
          isEmergency: true,
        },
      });
    }

    res.send({ Success: true, Message: 'Building deactivated.' });
  } catch (err) {
    console.error('PUT /api/building/deactivate/:id error:', err);
    res.send({ Success: false, Message: 'Server error.' });
  }
});

// The anonymous /api/building/evacuated and /api/building/emergencyCall
// handlers moved to src/features/emergency/emergency.routes.js, which registers
// both legacy paths as aliases of the new /api/emergency/... endpoints.

export default router;
