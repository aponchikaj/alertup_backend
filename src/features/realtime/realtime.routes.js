import { Router } from 'express';
import prisma from '../../db/prisma.js';
import whoami from '../../middlewares/whoami.js';
import { requireMembership } from '../../middlewares/requireBuildingPermission.js';
import { fail } from '../../utils/respond.js';
import { isId } from '../../utils/ids.js';
import { getStatus } from '../emergency/emergencyService.js';
import { subscribe, atCapacity, registerCloser } from './broadcaster.js';
import { initSse, sendEvent, startHeartbeat } from './sseHelpers.js';

const router = Router();

// SSE endpoints. Every connection gets a `state` snapshot immediately, so
// reconnects self-heal without Last-Event-ID bookkeeping and clients never
// need a separate status fetch.

async function openStream(req, res, buildingId, { includeLogs = false } = {}) {
  if (atCapacity(buildingId)) {
    res.set('Retry-After', '30');
    return fail(res, 503, 'Too many live connections for this building. Falling back to polling.');
  }

  initSse(res);

  const snapshot = await getStatus(buildingId);
  sendEvent(res, 'state', snapshot);

  if (includeLogs) {
    const since = req.query.since ? new Date(String(req.query.since)) : null;
    const logs = await prisma.log.findMany({
      where: {
        buildingId,
        isEmergency: true,
        ...(since && !Number.isNaN(since.getTime())
          ? { createdAt: { gt: since } }
          : snapshot.startedAt
            ? { createdAt: { gte: snapshot.startedAt } }
            : { createdAt: { gt: new Date() } }),
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    for (const log of logs) {
      sendEvent(res, 'log_appended', {
        id: log.id,
        message: log.message,
        type: log.type,
        createdAt: log.createdAt,
      });
    }
  }

  const stopHeartbeat = startHeartbeat(res);
  const unsubscribe = subscribe(buildingId, ({ event, data }) => {
    if (!includeLogs && (event === 'log_appended' || event === 'counters_updated')) {
      return; // public stream carries emergency state only
    }
    try {
      sendEvent(res, event, data);
    } catch {
      cleanup();
    }
  });
  const unregister = registerCloser(() => {
    try {
      res.end();
    } catch {
      // already closed
    }
  });

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    stopHeartbeat();
    unsubscribe();
    unregister();
  }

  req.on('close', cleanup);
  res.on('error', cleanup);
}

// Public: emergency state broadcast for scan/route pages. No auth — anyone
// physically in the building must receive the alert.
router.get('/api/realtime/buildings/:buildingId/status', async (req, res) => {
  try {
    const { buildingId } = req.params;
    if (!isId(buildingId)) return fail(res, 400, 'Invalid building id.');
    const building = await prisma.building.findUnique({
      where: { id: buildingId },
      select: { id: true },
    });
    if (!building) return fail(res, 404, 'Building not found.');
    await openStream(req, res, buildingId, { includeLogs: false });
  } catch (err) {
    console.error('Realtime status stream error:', err);
    if (!res.headersSent) fail(res, 500, 'Server error.');
  }
});

// Member-only: full feed incl. live emergency logs and counters. Replaces the
// 10-second polling of /api/administration/logs/:id.
router.get(
  '/api/realtime/buildings/:buildingId/feed',
  whoami,
  requireMembership,
  async (req, res) => {
    try {
      await openStream(req, res, req.building.id, { includeLogs: true });
    } catch (err) {
      console.error('Realtime feed stream error:', err);
      if (!res.headersSent) fail(res, 500, 'Server error.');
    }
  }
);

export default router;
