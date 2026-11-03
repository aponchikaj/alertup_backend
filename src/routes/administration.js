import express from 'express';
import prisma from '../db/prisma.js';
import whoami from '../middlewares/whoami.js';
import {
  requirePermission,
  requireMembership,
} from '../middlewares/requireBuildingPermission.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { isId } from '../utils/ids.js';
import { ok, fail } from '../utils/respond.js';
import {
  triggerEmergency,
  resolveEmergency,
} from '../features/emergency/emergencyService.js';
import { verifyChallenge } from '../features/emergency/challenge.js';

const router = express.Router();

// LEGACY COMPATIBILITY LAYER for the deployed administration UI. The new
// endpoints live in src/features/emergency/emergency.routes.js; these keep the
// old paths and the toggle semantics working (FX-067: now on the standard
// { success, message, data } envelope; the frontend shim mirrors it)
// on top of emergencyService and the Prisma tables.

/** Map a Prisma Log row to the legacy log document shape. */
const legacyLog = (log) => ({
  _id: log.id,
  logType: log.type.toLowerCase(),
  logMessage: log.message,
  buildingID: log.buildingId,
  isEmergency: log.isEmergency,
  createdAt: log.createdAt,
});

/** Map a Prisma EmergencyEvent row to the legacy emergency document shape. */
const legacyEmergency = (event, { includeBuildingId = true } = {}) => ({
  _id: event.id,
  ...(includeBuildingId ? { buildingID: event.buildingId } : {}),
  isFinished: event.status === 'RESOLVED',
  scanned: event.scanned,
  evacuated: event.evacuated,
  calledEmergency: event.calledEmergency,
  startedAt: event.startedAt,
  endedAt: event.endedAt,
  createdAt: event.createdAt,
  updatedAt: event.updatedAt,
});

// The legacy client posts { buildingID } (capital D). requireBuildingPermission
// resolves req.body.buildingId, so lift the value across — with the legacy 400
// shape for an invalid id.
const liftBuildingID = (req, res, next) => {
  const buildingID = req.body?.buildingID;
  if (!buildingID || !isId(String(buildingID))) {
    return fail(res, 400, 'Invalid building ID.');
  }
  req.body.buildingId = String(buildingID);
  next();
};

/* ---------------- EMERGENCY TOGGLE ---------------- */
// The deployed panic button is a toggle: read the current state and flip it.
// The explicit trigger/resolve services underneath are idempotent, so a
// double-tapped button can no longer open two parallel emergencies.
router.post(
  '/api/administration/emergency',
  whoami,
  liftBuildingID,
  requirePermission(PERMISSIONS.CAN_TRIGGER_EMERGENCY),
  async (req, res) => {
    try {
      // Same arming challenge as the v2 trigger/resolve routes: flipping a
      // whole building into evacuation mode must survive a mis-tap. 428 tells
      // the client to run the challenge flow; 403 means the answer was wrong.
      const challenge = req.body?.challenge;
      if (!challenge?.token) {
        return fail(res, 428, 'CHALLENGE_REQUIRED');
      }
      if (!verifyChallenge(challenge.token, challenge.answer)) {
        return fail(res, 403, 'CHALLENGE_FAILED');
      }

      if (req.building.emergencyMode === false) {
        await triggerEmergency(req.building.id, {
          userId: req.user.id,
          trigger: 'ADMIN',
        });
      } else {
        await resolveEmergency(req.building.id, { userId: req.user.id });
      }

      return ok(res, { message: 'Saved.' });
    } catch (err) {
      console.error('Emergency toggle error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

/* ---------------- LIVE EMERGENCY LOGS ---------------- */
router.get('/api/administration/logs/:id', whoami, requireMembership, async (req, res) => {
  try {
    const building = req.building;

    if (building.emergencyMode === false) {
      return fail(res, 200, 'Emergency mode is off.');
    }

    const emergency = await prisma.emergencyEvent.findFirst({
      where: { buildingId: building.id, status: 'ACTIVE' },
      orderBy: { startedAt: 'desc' },
    });
    if (!emergency) {
      return fail(res, 200, 'No active emergency found.');
    }

    const logs = await prisma.log.findMany({
      where: {
        buildingId: building.id,
        isEmergency: true,
        createdAt: { gte: emergency.startedAt },
      },
      orderBy: { createdAt: 'asc' },
    });

    return ok(res, { data: logs.map(legacyLog) });
  } catch (err) {
    console.error(err);
    return fail(res, 200, 'Server error.');
  }
});

/* ---------------- FINISHED-EMERGENCY ANALYTICS (list) ---------------- */
router.get(
  '/api/administration/analytics/:buildingId',
  whoami,
  requirePermission(PERMISSIONS.CAN_VIEW_ANALYTICS),
  async (req, res) => {
    const { dateFrom, dateTo } = req.query;

    try {
      const createdAt = {};
      if (dateFrom && !isNaN(new Date(dateFrom))) createdAt.gte = new Date(dateFrom);
      if (dateTo && !isNaN(new Date(dateTo))) createdAt.lte = new Date(dateTo);

      const emergencies = await prisma.emergencyEvent.findMany({
        where: {
          buildingId: req.building.id,
          status: 'RESOLVED',
          ...(Object.keys(createdAt).length ? { createdAt } : {}),
        },
        orderBy: { createdAt: 'desc' },
      });

      return ok(res, { data: emergencies.map(legacyEmergency) });
    } catch (err) {
      console.error('Error occured while getting analytics.', err);
      return fail(res, 200, 'Server error.');
    }
  }
);

/* ---------------- FINISHED-EMERGENCY ANALYTICS (detail) ---------------- */
router.get(
  '/api/administration/analytics/:buildingId/:emergencyID',
  whoami,
  requirePermission(PERMISSIONS.CAN_VIEW_ANALYTICS),
  async (req, res) => {
    const { emergencyID } = req.params;
    if (!emergencyID || !isId(emergencyID)) {
      return fail(res, 400, 'Invalid parameters.');
    }
    const { logType, dateFrom, dateTo } = req.query;

    try {
      const emergency = await prisma.emergencyEvent.findFirst({
        where: { id: emergencyID, buildingId: req.building.id, status: 'RESOLVED' },
      });
      if (!emergency) {
        return fail(res, 404, 'Invalid emergency.');
      }

      const STARTED_DATE = dateFrom ? new Date(dateFrom) : emergency.startedAt;
      const FINISHED_DATE = dateTo ? new Date(dateTo) : emergency.endedAt;

      if (
        !STARTED_DATE ||
        !FINISHED_DATE ||
        isNaN(STARTED_DATE.getTime()) ||
        isNaN(FINISHED_DATE.getTime())
      ) {
        return fail(res, 400, 'Invalid date format.');
      }

      // Legacy clients filter with the lowercase vocabulary ('scan',
      // 'evacuated', ...). Map to the LogType enum; an unknown value matches
      // nothing, same as before.
      const LOG_TYPES = ['SYSTEM', 'REPORT', 'ERROR', 'SCAN', 'EVACUATED', 'EMERGENCY'];
      let typeFilter;
      if (logType) {
        const mapped = String(logType).toUpperCase();
        typeFilter = LOG_TYPES.includes(mapped) ? mapped : '__NONE__';
      }
      if (typeFilter === '__NONE__') {
        return fail(res, 200, 'Logs not found.');
      }

      // isEmergency: true, matching GET /api/administration/logs/:id — this is
      // the incident feed for one resolved emergency, not a general log
      // browser. Without it, a B14 audit row (SYSTEM, isEmergency: false) for
      // an unrelated map edit that happened to land in the same time window
      // shows up as if it were part of the incident, and — correctly, since
      // audit rows are exempt from `logs/clear` — can never be cleared out of
      // this view either.
      const logs = await prisma.log.findMany({
        where: {
          buildingId: req.building.id,
          isEmergency: true,
          createdAt: { gte: STARTED_DATE, lte: FINISHED_DATE },
          ...(typeFilter ? { type: typeFilter } : {}),
        },
        orderBy: { createdAt: 'asc' },
      });

      if (!logs || logs.length === 0) {
        return fail(res, 200, 'Logs not found.');
      }

      return ok(res, {
        data: {
          logs: logs.map(legacyLog),
          emergency: legacyEmergency(emergency, { includeBuildingId: false }),
        },
      });
    } catch (e) {
      console.error('Error occured while getting emergency analytics.', e);
      return fail(res, 500, 'Server error.');
    }
  }
);

/* ---------------- CLEAR LOGS ---------------- */
// Clears the live emergency-feed noise (isEmergency: true — what
// GET /api/administration/logs/:id reads), never the accountability trail.
// Audit rows (B14) default to isEmergency: false specifically so this
// building-wide delete cannot sweep them up — a building may be legally
// required to keep a record of who changed what, even after the incident
// that made them look at the logs is long over.
router.post(
  '/api/administration/logs/clear/:id',
  whoami,
  requirePermission(PERMISSIONS.CAN_TRIGGER_EMERGENCY),
  async (req, res) => {
    try {
      // FX-050: only the CURRENT incident's feed. Deleting every isEmergency
      // row also wiped the feeds of past, resolved emergencies — the record
      // emergency analytics reads by time window.
      const active = await prisma.emergencyEvent.findFirst({
        where: { buildingId: req.building.id, status: 'ACTIVE' },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
      });
      if (!active) {
        return fail(res, 409, 'No active emergency to clear.');
      }
      const result = await prisma.log.deleteMany({
        where: { buildingId: req.building.id, isEmergency: true, createdAt: { gte: active.startedAt } },
      });

      return ok(res, { message: `${result.count} logs deleted` });
    } catch (err) {
      console.error(err);
      return fail(res, 200, 'Server error.');
    }
  }
);

export default router;
