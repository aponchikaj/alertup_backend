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
    // console.log(USER.scanned)
    // Build dashboard object
    const dashboardData = {
      MyBuildings: USER.Buildings.length,
      scanned: USER.scanned.length,
      myBuildingsScanned: totalScans,
      lastScanned: USER.scanned.length > 0 ? USER.scanned[USER.scanned.length - 1].buildingName : null,
      premiumStatus: USER.premium.hasPremium ? USER.premium.premiumType : "Free",
      premiumExpires: USER.premium.to || null,
    };

    return res.send({ Success: true, Message: dashboardData });

  } catch (err) {
    console.error(err);
    return res.send({ Success: false, Message: 'Server error.' });
  }
});

export default router;
