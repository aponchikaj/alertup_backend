import { Router } from 'express';
import prisma from '../../db/prisma.js';
import whoami from '../../middlewares/whoami.js';
import { requirePermission } from '../../middlewares/requireBuildingPermission.js';
import { ok, fail } from '../../utils/respond.js';
import { isId } from '../../utils/ids.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import { editorWriteLimiter } from '../../services/rateLimiter.js';
import { publish } from '../realtime/broadcaster.js';
import { invalidateClosures, publicClosure } from '../wayfinding/closures.js';

/**
 * Closure CRUD for the map editor.
 *
 * Nested under `/buildings/:buildingId/...` because that is the only shape
 * `requireBuildingPermission` resolves for a route with no node/floor/edge of
 * its own — a top-level `/closures/:closureId` would have nothing to scope
 * the permission check against.
 *
 * Every write:
 *   1. validates the ids against THIS building (a closure naming another
 *      building's edge is either a bug or an attempt to shut someone else's
 *      corridor),
 *   2. `invalidateClosures` so the router picks it up on the next request
 *      rather than up to 15 s later,
 *   3. `publish`es `closure_changed` so every open scan page re-routes
 *      itself without waiting for a poll.
 *
 * Kept deliberately audit-free: B14 adds the audit row, and with it the
 * `$transaction` that makes the row and the write atomic. A transaction
 * around today's single statement would buy nothing.
 */

const router = Router();

const canEditMap = [whoami, requirePermission(PERMISSIONS.CAN_EDIT_MAP)];

const MAX_REASON = 200;
/** A closure naming more ids than this is a script, not an incident. */
const MAX_IDS = 500;

/** The editor's view: the public shape plus the operational detail an owner
 *  needs to manage the row (which ids, who made it, is it live right now). */
const editorClosure = (row, now = new Date()) => ({
  ...publicClosure(row),
  edgeIds: row.edgeIds,
  nodeIds: row.nodeIds,
  createdById: row.createdById ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  active: row.startsAt <= now && (row.endsAt === null || row.endsAt > now),
});

const parseIdList = (raw, label) => {
  if (raw === undefined || raw === null) return { value: undefined };
  if (!Array.isArray(raw)) return { error: `${label} must be an array of ids.` };
  if (raw.length > MAX_IDS) return { error: `${label} may not hold more than ${MAX_IDS} ids.` };
  const value = [...new Set(raw.map((id) => String(id)))];
  if (value.some((id) => !isId(id))) return { error: `${label} contains an invalid id.` };
  return { value };
};

const parseInstant = (raw, label) => {
  if (raw === undefined) return { value: undefined };
  if (raw === null || raw === '') return { value: null };
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return { error: `${label} must be a date.` };
  return { value: date };
};

/**
 * Validate a create or patch body against the building it is scoped to.
 *
 * `current` is the existing row on a patch, so a partial write is validated
 * against what the closure will BE, not just against the fields that moved —
 * clearing the last edge id of a closure that has no floor either must fail
 * the same way creating that closure would.
 *
 * @returns {{data:object, error:null}|{data:null, error:string}}
 */
async function readClosureBody(body = {}, { buildingId, current = null }) {
  const data = {};

  const edgeIds = parseIdList(body.edgeIds, 'edgeIds');
  if (edgeIds.error) return { data: null, error: edgeIds.error };
  if (edgeIds.value !== undefined) data.edgeIds = edgeIds.value;

  const nodeIds = parseIdList(body.nodeIds, 'nodeIds');
  if (nodeIds.error) return { data: null, error: nodeIds.error };
  if (nodeIds.value !== undefined) data.nodeIds = nodeIds.value;

  if (body.floorId !== undefined) {
    if (body.floorId === null || body.floorId === '') {
      data.floorId = null;
    } else if (!isId(String(body.floorId))) {
      return { data: null, error: 'floorId must be a valid id.' };
    } else {
      data.floorId = String(body.floorId);
    }
  }

  if (body.costMultiplier !== undefined) {
    if (body.costMultiplier === null || body.costMultiplier === '') {
      // The blocking form: no multiplier is high enough to mean "impassable",
      // so null carries it rather than a magic number.
      data.costMultiplier = null;
    } else {
      const multiplier = Number(body.costMultiplier);
      if (!Number.isFinite(multiplier) || multiplier < 1) {
        return {
          data: null,
          error: 'costMultiplier must be null (blocked) or a number of at least 1.',
        };
      }
      data.costMultiplier = multiplier;
    }
  }

  if (body.reason !== undefined) {
    if (body.reason === null) {
      data.reason = null;
    } else if (typeof body.reason !== 'string') {
      return { data: null, error: 'reason must be a string.' };
    } else {
      const reason = body.reason.trim();
      if (reason.length > MAX_REASON) {
        return { data: null, error: `reason must be ${MAX_REASON} characters or fewer.` };
      }
      data.reason = reason || null;
    }
  }

  const startsAt = parseInstant(body.startsAt, 'startsAt');
  if (startsAt.error) return { data: null, error: startsAt.error };
  if (startsAt.value !== undefined) {
    if (startsAt.value === null) return { data: null, error: 'startsAt may not be cleared.' };
    data.startsAt = startsAt.value;
  }

  const endsAt = parseInstant(body.endsAt, 'endsAt');
  if (endsAt.error) return { data: null, error: endsAt.error };
  if (endsAt.value !== undefined) data.endsAt = endsAt.value;

  // Merged view — what the row looks like after this write lands.
  const merged = {
    edgeIds: data.edgeIds ?? current?.edgeIds ?? [],
    nodeIds: data.nodeIds ?? current?.nodeIds ?? [],
    floorId: data.floorId !== undefined ? data.floorId : (current?.floorId ?? null),
    startsAt: data.startsAt ?? current?.startsAt ?? new Date(),
    endsAt: data.endsAt !== undefined ? data.endsAt : (current?.endsAt ?? null),
  };

  if (merged.endsAt !== null && merged.endsAt <= merged.startsAt) {
    return { data: null, error: 'endsAt must be after startsAt.' };
  }

  if (merged.edgeIds.length === 0 && merged.nodeIds.length === 0 && !merged.floorId) {
    return {
      data: null,
      error: 'A closure must name at least one edge, node or floor.',
    };
  }

  // Everything this closure points at has to live in this building. Checked in
  // one query per kind, against the merged view rather than only the incoming
  // fields, so a patch cannot smuggle a foreign id in beside an untouched one.
  const [edgeCount, nodeCount, floor] = await Promise.all([
    merged.edgeIds.length
      ? prisma.edge.count({ where: { buildingId, id: { in: merged.edgeIds } } })
      : 0,
    merged.nodeIds.length
      ? prisma.node.count({ where: { buildingId, id: { in: merged.nodeIds } } })
      : 0,
    merged.floorId
      ? prisma.floor.findFirst({ where: { buildingId, id: merged.floorId }, select: { id: true } })
      : null,
  ]);

  if (edgeCount !== merged.edgeIds.length) {
    return { data: null, error: 'Every edge id must belong to this building.' };
  }
  if (nodeCount !== merged.nodeIds.length) {
    return { data: null, error: 'Every node id must belong to this building.' };
  }
  if (merged.floorId && !floor) {
    return { data: null, error: 'floorId must belong to this building.' };
  }

  return { data, error: null };
}

/** The `closure_changed` SSE payload, per the wire contract. */
const changedEvent = (row, action) => ({
  closureId: row.id,
  action,
  blocked: row.costMultiplier === null,
  edgeIds: row.edgeIds,
  nodeIds: row.nodeIds,
  reason: row.reason ?? null,
  endsAt: row.endsAt ? row.endsAt.toISOString() : null,
});

/** Invalidate then announce — in that order, so a client that re-routes the
 *  instant it sees the event never reads a stale cache. */
const announce = (buildingId, row, action) => {
  invalidateClosures(buildingId);
  publish(buildingId, 'closure_changed', changedEvent(row, action));
};

// ------------------------------------------------------------------ read ---

/**
 * GET /api/map-editor/buildings/:buildingId/closures
 *
 * Everything on the books — live, scheduled and finished — because the
 * editor's job is to manage the list, not just to see what is in force. Each
 * row carries `active` so the UI does not have to redo the clock arithmetic.
 */
router.get(
  '/api/map-editor/buildings/:buildingId/closures',
  ...canEditMap,
  async (req, res) => {
    try {
      const rows = await prisma.closure.findMany({
        where: { buildingId: req.building.id },
        orderBy: { startsAt: 'desc' },
        take: 500,
      });
      const now = new Date();
      return ok(res, { data: { closures: rows.map((row) => editorClosure(row, now)) } });
    } catch (err) {
      console.error('List closures error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

// ----------------------------------------------------------------- write ---

router.post(
  '/api/map-editor/buildings/:buildingId/closures',
  ...canEditMap,
  editorWriteLimiter,
  async (req, res) => {
    try {
      const { data, error } = await readClosureBody(req.body, {
        buildingId: req.building.id,
      });
      if (error) return fail(res, 422, error);

      const row = await prisma.closure.create({
        data: {
          buildingId: req.building.id,
          edgeIds: data.edgeIds ?? [],
          nodeIds: data.nodeIds ?? [],
          floorId: data.floorId ?? null,
          // Absent means blocked: an owner reaching for this during an
          // incident means "do not send anyone through here", and the
          // penalty form is the deliberate, explicit one.
          costMultiplier: data.costMultiplier ?? null,
          reason: data.reason ?? null,
          ...(data.startsAt ? { startsAt: data.startsAt } : {}),
          endsAt: data.endsAt ?? null,
          createdById: req.user?.id ?? null,
        },
      });

      announce(req.building.id, row, 'created');
      return ok(res, {
        status: 201,
        message: 'Closure created.',
        data: { closure: editorClosure(row) },
      });
    } catch (err) {
      console.error('Create closure error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

router.patch(
  '/api/map-editor/buildings/:buildingId/closures/:closureId',
  ...canEditMap,
  editorWriteLimiter,
  async (req, res) => {
    try {
      const { closureId } = req.params;
      // Scoped to the building the permission check passed for — a closure id
      // from elsewhere is "not found" here, never "forbidden", which would
      // confirm it exists.
      const current = await prisma.closure.findFirst({
        where: { id: closureId, buildingId: req.building.id },
      });
      if (!current) return fail(res, 404, 'Closure not found.');

      const { data, error } = await readClosureBody(req.body, {
        buildingId: req.building.id,
        current,
      });
      if (error) return fail(res, 422, error);

      const row = await prisma.closure.update({ where: { id: current.id }, data });

      announce(req.building.id, row, 'updated');
      return ok(res, { message: 'Closure updated.', data: { closure: editorClosure(row) } });
    } catch (err) {
      console.error('Update closure error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

router.delete(
  '/api/map-editor/buildings/:buildingId/closures/:closureId',
  ...canEditMap,
  editorWriteLimiter,
  async (req, res) => {
    try {
      const { closureId } = req.params;
      const current = await prisma.closure.findFirst({
        where: { id: closureId, buildingId: req.building.id },
      });
      if (!current) return fail(res, 404, 'Closure not found.');

      await prisma.closure.delete({ where: { id: current.id } });

      // Announced from the row as it was: the client needs to know WHICH
      // restriction lifted, and after the delete there is nothing to read.
      announce(req.building.id, current, 'deleted');
      return ok(res, { message: 'Closure removed.', data: { closureId: current.id } });
    } catch (err) {
      console.error('Delete closure error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

export default router;
