import { Router } from 'express';
import whoami from '../../middlewares/whoami.js';
import { requirePermission } from '../../middlewares/requireBuildingPermission.js';
import { ok, fail } from '../../utils/respond.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import { emergencyActionLimiter, publicReadLimiter } from '../../services/rateLimiter.js';
import { isId } from '../../utils/ids.js';
import prisma from '../../db/prisma.js';
import {
  getStatus,
  triggerEmergency,
  resolveEmergency,
  recordAction,
} from './emergencyService.js';

const router = Router();

router.post(
  '/api/emergency/buildings/:buildingId/trigger',
  whoami,
  requirePermission(PERMISSIONS.CAN_TRIGGER_EMERGENCY),
  async (req, res) => {
    try {
      let { message } = req.body || {};
      if (message !== undefined && message !== null) {
        if (typeof message !== 'string') return fail(res, 422, 'message must be a string.');
        message = message.trim().slice(0, 500) || null;
      } else {
        message = null;
      }

      const result = await triggerEmergency(req.building.id, {
        message,
        userId: req.user.id,
        trigger: 'ADMIN',
      });
      return ok(res, {
        message: result.alreadyActive
          ? 'Emergency was already active.'
          : 'Emergency activated.',
        data: {
          alreadyActive: result.alreadyActive,
          emergencyId: result.event?.id || null,
        },
      });
    } catch (err) {
      console.error('Trigger emergency error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

router.post(
  '/api/emergency/buildings/:buildingId/resolve',
  whoami,
  requirePermission(PERMISSIONS.CAN_TRIGGER_EMERGENCY),
  async (req, res) => {
    try {
      const result = await resolveEmergency(req.building.id);
      return ok(res, {
        message: result.alreadyResolved
          ? 'No active emergency.'
          : 'Emergency resolved.',
        data: { alreadyResolved: result.alreadyResolved },
      });
    } catch (err) {
      console.error('Resolve emergency error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

router.get(
  '/api/emergency/buildings/:buildingId/status',
  publicReadLimiter,
  async (req, res) => {
    try {
      const { buildingId } = req.params;
      if (!isId(buildingId)) return fail(res, 400, 'Invalid building id.');
      const status = await getStatus(buildingId);
      if (!status) return fail(res, 404, 'Building not found.');
      return ok(res, { data: status });
    } catch (err) {
      console.error('Emergency status error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

// Anonymous occupant actions. Deliberately unauthenticated — rate-limited
// instead. buildingId in the body for backwards compatibility with the old
// /api/building/evacuated + /api/building/emergencyCall endpoints, which are
// aliased below for one release.
async function handleAction(req, res, action) {
  try {
    const buildingId = req.params.buildingId || req.body?.buildingId;
    if (!buildingId || !isId(buildingId)) {
      return fail(res, 400, 'Invalid building id.');
    }
    const building = await prisma.building.findUnique({
      where: { id: buildingId },
      select: { id: true },
    });
    if (!building) return fail(res, 404, 'Building not found.');

    await recordAction(buildingId, action);
    return ok(res, { message: 'Recorded.' });
  } catch (err) {
    console.error(`Emergency ${action} error:`, err);
    return fail(res, 500, 'Server error.');
  }
}

router.post(
  '/api/emergency/buildings/:buildingId/evacuated',
  emergencyActionLimiter,
  (req, res) => handleAction(req, res, 'evacuated')
);
router.post(
  '/api/emergency/buildings/:buildingId/called',
  emergencyActionLimiter,
  (req, res) => handleAction(req, res, 'called')
);

// Legacy aliases (printed instructions / deployed frontend still post here).
router.post('/api/building/evacuated', emergencyActionLimiter, (req, res) =>
  handleAction(req, res, 'evacuated')
);
router.post('/api/building/emergencyCall', emergencyActionLimiter, (req, res) =>
  handleAction(req, res, 'called')
);

export default router;
