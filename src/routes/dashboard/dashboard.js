import express from 'express';
import prisma from '../../db/prisma.js';
import whoami from '../../middlewares/whoami.js';

const router = express.Router();

// Legacy envelope + keys (MyBuildings, scanned, myBuildingsScanned,
// lastScanned, recentScans, scanActivity) — the deployed dashboard reads them.
// premiumStatus/premiumExpires are gone with the premium system.

router.get('/api/dashboard', whoami, async (req, res) => {
  try {
    const userId = req.user.id;

    const DAYS = 14;
    const activityStart = new Date();
    activityStart.setUTCHours(0, 0, 0, 0);
    activityStart.setUTCDate(activityStart.getUTCDate() - (DAYS - 1));

    const [myBuildings, ownedScanSum, totalScans, recent, activityRows] =
      await Promise.all([
        prisma.building.count({ where: { ownerId: userId } }),
        // Sum of every floor scan across the user's own buildings — the old
        // maps.scanned aggregation, now a Floor.scanCount sum.
        prisma.floor.aggregate({
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
      myBuildingsScanned: ownedScanSum._sum.scanCount || 0,
      lastScanned: recentScans[0]?.buildingName || null,
      recentScans,
      scanActivity,
    };

    return res.send({ Success: true, Message: dashboardData });
  } catch (err) {
    console.error(err);
    return res.send({ Success: false, Message: 'Server error.' });
  }
});

export default router;
