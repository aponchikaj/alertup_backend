import express from 'express';
const router = express.Router();

import whoami from '../../middlewares/whoami.js';
import USERS from '../../models/user.model.js';
import BUILDINGS from '../../models/building.model.js';

router.get('/api/dashboard', whoami, async (req, res) => {
  try {
    const USER = await USERS.findById(req.user._id);

    if (!USER) {
      return res.send({ Success: false, Message: "Something went wrong." });
    }

    // Aggregate total scans on user's buildings
    const buildingScans = await BUILDINGS.aggregate([
      { $match: { owner: USER._id } },
      { $unwind: "$maps" },
      {
        $group: {
          _id: null,
          totalScans: { $sum: "$maps.scanned" }
        }
      }
    ]);

    const totalScans = buildingScans[0]?.totalScans || 0;

    // Most recent scans, newest first, for the dashboard table.
    const scans = USER.scanned || [];
    const recentScans = [...scans]
      .slice(-8)
      .reverse()
      .map((s) => ({
        buildingName: s.buildingName || null,
        scannedAt: s.scannedAt || null,
        buildingID: s.buildingID || null,
      }));

    // Scans-per-day for the last 14 days (UTC buckets) for the activity chart.
    const DAYS = 14;
    const today = new Date();
    const buckets = new Map();
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      buckets.set(d.toISOString().slice(0, 10), 0);
    }
    for (const s of scans) {
      if (!s.scannedAt) continue;
      const t = new Date(s.scannedAt);
      if (isNaN(t.getTime())) continue;
      const key = t.toISOString().slice(0, 10);
      if (buckets.has(key)) buckets.set(key, buckets.get(key) + 1);
    }
    const scanActivity = [...buckets.entries()].map(([date, count]) => ({ date, count }));

    // Build dashboard object
    const dashboardData = {
      MyBuildings: USER.Buildings.length,
      scanned: USER.scanned.length,
      myBuildingsScanned: totalScans,
      lastScanned: USER.scanned.length > 0 ? USER.scanned[USER.scanned.length - 1].buildingName : null,
      premiumStatus: USER.premium.hasPremium ? USER.premium.premiumType : "Free",
      premiumExpires: USER.premium.to || null,
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
