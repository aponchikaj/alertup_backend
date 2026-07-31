import express from 'express';
import prisma from '../../db/prisma.js';
import whoami from '../../middlewares/whoami.js';
import {
  requirePermission,
  requireMembership,
} from '../../middlewares/requireBuildingPermission.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import { isId } from '../../utils/ids.js';
import {
  triggerEmergency,
  resolveEmergency,
} from '../../features/emergency/emergencyService.js';

const router = express.Router();

// LEGACY COMPATIBILITY LAYER for the deployed administration UI. The new
// endpoints live in src/features/emergency/emergency.routes.js; these keep the
// old paths, the {Success, Message} envelope and the toggle semantics working
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
    return res.status(400).send({ Success: false, Message: 'Invalid building ID.' });
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
      if (req.building.emergencyMode === false) {
        await triggerEmergency(req.building.id, {
          userId: req.user.id,
          trigger: 'ADMIN',
        });
      } else {
        await resolveEmergency(req.building.id);
      }

      return res.send({ Success: true, Message: 'Saved.' });
    } catch (err) {
      console.error('Emergency toggle error:', err);
      return res.status(500).send({ Success: false, Message: 'Server error.' });
    }
  }
);

/* ---------------- LIVE EMERGENCY LOGS ---------------- */
router.get('/api/administration/logs/:id', whoami, requireMembership, async (req, res) => {
  try {
    const building = req.building;

    if (building.emergencyMode === false) {
      return res.send({ Success: false, Message: 'Emergency mode is off.' });
    }

    const emergency = await prisma.emergencyEvent.findFirst({
      where: { buildingId: building.id, status: 'ACTIVE' },
      orderBy: { startedAt: 'desc' },
    });
    if (!emergency) {
      return res.send({ Success: false, Message: 'No active emergency found.' });
    }

    const logs = await prisma.log.findMany({
      where: {
        buildingId: building.id,
        isEmergency: true,
        createdAt: { gte: emergency.startedAt },
      },
      orderBy: { createdAt: 'asc' },
    });

    return res.send({ Success: true, Message: logs.map(legacyLog) });
  } catch (err) {
    console.error(err);
    return res.send({ Success: false, Message: 'Server error.' });
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

      return res.send({ Success: true, Message: emergencies.map(legacyEmergency) });
    } catch (err) {
      console.error('Error occured while getting analytics.', err);
      return res.send({ Success: false, Message: 'Server error.' });
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
      return res.status(400).send({ Success: false, Message: 'Invalid parameters.' });
    }
    const { logType, dateFrom, dateTo } = req.query;

    try {
      const emergency = await prisma.emergencyEvent.findFirst({
        where: { id: emergencyID, buildingId: req.building.id, status: 'RESOLVED' },
      });
      if (!emergency) {
        return res.status(404).send({ Success: false, Message: 'Invalid emergency.' });
      }

      const STARTED_DATE = dateFrom ? new Date(dateFrom) : emergency.startedAt;
      const FINISHED_DATE = dateTo ? new Date(dateTo) : emergency.endedAt;

      if (
        !STARTED_DATE ||
        !FINISHED_DATE ||
        isNaN(STARTED_DATE.getTime()) ||
        isNaN(FINISHED_DATE.getTime())
      ) {
        return res.status(400).send({ Success: false, Message: 'Invalid date format.' });
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
        return res.send({ Success: false, Message: 'Logs not found.' });
      }

      const logs = await prisma.log.findMany({
        where: {
          buildingId: req.building.id,
          createdAt: { gte: STARTED_DATE, lte: FINISHED_DATE },
          ...(typeFilter ? { type: typeFilter } : {}),
        },
        orderBy: { createdAt: 'asc' },
      });

      if (!logs || logs.length === 0) {
        return res.send({ Success: false, Message: 'Logs not found.' });
      }

      return res.send({
        Success: true,
        Message: {
          logs: logs.map(legacyLog),
          emergency: legacyEmergency(emergency, { includeBuildingId: false }),
        },
      });
    } catch (e) {
      console.error('Error occured while getting emergency analytics.', e);
      return res.status(500).send({ Success: false, Message: 'Server error.' });
    }
  }
);

/* ---------------- CLEAR LOGS ---------------- */
router.post(
  '/api/administration/logs/clear/:id',
  whoami,
  requirePermission(PERMISSIONS.CAN_TRIGGER_EMERGENCY),
  async (req, res) => {
    try {
      const result = await prisma.log.deleteMany({
        where: { buildingId: req.building.id },
      });

      return res.send({
        Success: true,
        Message: `${result.count} logs deleted`,
      });
    } catch (err) {
      console.error(err);
      return res.send({ Success: false, Message: 'Server error.' });
    }
  }
);

export default router;
