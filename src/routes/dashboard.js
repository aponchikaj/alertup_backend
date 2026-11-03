import express from 'express';
import prisma from '../db/prisma.js';
import whoami from '../middlewares/whoami.js';
import { ok, fail } from '../utils/respond.js';

const router = express.Router();

// Legacy envelope + keys (MyBuildings, scanned, myBuildingsScanned,
// lastScanned, recentScans, scanActivity) — the deployed dashboard reads them.
// premiumStatus/premiumExpires now carry the account plan (the plan card
// read them after they had stopped being sent, so every account showed as
// paid with an empty value). Plans have no expiry yet, so it is null.

const PLAN_LABELS = { FREE: 'Free', STARTER: 'Starter', BUSINESS: 'Business' };

router.get('/api/dashboard', whoami, async (req, res) => {
  try {
    const userId = req.user.id;

    const DAYS = 14;
    const activityStart = new Date();
    activityStart.setUTCHours(0, 0, 0, 0);
    activityStart.setUTCDate(activityStart.getUTCDate() - (DAYS - 1));

    const [myBuildings, floorScanSum, nodeScanSum, totalScans, recent, activityRows] =
      await Promise.all([
        prisma.building.count({ where: { ownerId: userId } }),
        // Every scan across the user's own buildings: floor QR codes count on
        // Floor.scanCount, sticker (node) QR codes, the main path, on
        // Node.scanCount. It used to sum floors only (BE-32).
        prisma.floor.aggregate({
          _sum: { scanCount: true },
          where: { building: { ownerId: userId } },
        }),
        prisma.node.aggregate({
          _sum: { scanCount: true },
          where: { building: { ownerId: userId } },
        }),
        prisma.scanEvent.count({ where: { userId } }),
        prisma.scanEvent.findMany({
          where: { userId },
          orderBy: { scannedAt: 'desc' },
          take: 8,
          select: { buildingName: true, scannedAt: true, buildingId: true },
        }),
        prisma.scanEvent.findMany({
          where: { userId, scannedAt: { gte: activityStart } },
          select: { scannedAt: true },
        }),
      ]);

    const recentScans = recent.map((s) => ({
      buildingName: s.buildingName || null,
      scannedAt: s.scannedAt || null,
      buildingID: s.buildingId || null,
    }));

    // Scans-per-day for the last 14 days (UTC buckets) for the activity chart.
    const today = new Date();
    const buckets = new Map();
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      buckets.set(d.toISOString().slice(0, 10), 0);
    }
    for (const s of activityRows) {
      const key = s.scannedAt.toISOString().slice(0, 10);
      if (buckets.has(key)) buckets.set(key, buckets.get(key) + 1);
    }
    const scanActivity = [...buckets.entries()].map(([date, count]) => ({ date, count }));

    const dashboardData = {
      MyBuildings: myBuildings,
      scanned: totalScans,
      myBuildingsScanned: (floorScanSum._sum.scanCount || 0) + (nodeScanSum._sum.scanCount || 0),
      premiumStatus: PLAN_LABELS[req.user.plan] || PLAN_LABELS.FREE,
      premiumExpires: null,
      lastScanned: recentScans[0]?.buildingName || null,
      recentScans,
      scanActivity,
    };

    return ok(res, { data: dashboardData });
  } catch (err) {
    console.error(err);
    return fail(res, 200, 'Server error.');
  }
});

export default router;
