import express from 'express';
import upload from '../../middlewares/upload.js';
import whoami from '../../middlewares/whoami.js';
import QRCode from 'qrcode';
import USERS from '../../models/user.model.js';
import BUILDINGS from '../../models/building.model.js';
import mongoose from 'mongoose'
import {Filter} from 'bad-words';

const router = express.Router();

// -------------------------------------
// Helper: Check building name validity
// -------------------------------------
const checkBuildingName = async (userID, buildingName, buildingId = null) => {
  if (!userID || !buildingName) return "Something went wrong.";

  buildingName = buildingName.trim();
  if (buildingName.length < 4 || buildingName.length > 40)
    return "Building name must have from 4 to 40 characters.";

  const filter = new Filter();
  if (filter.isProfane(buildingName)) return "Building name contains bad words.";

  const query = { owner: userID, buildingName };
  if (buildingId) query._id = { $ne: buildingId }; // exclude current building

  const exists = await BUILDINGS.findOne(query);
  if (exists) return "Building name already exists in your buildings.";

  return true;
};

// -------------------------------------
// Helper: Determine max floors & buildings
// -------------------------------------
const checkPremiumSettings = (premium) => {
  const freePlan = { floors: 3, buildings: 1 };

  if (!premium || !premium.hasPremium) return { Success: true, Message: freePlan };

  const plans = {
    basic: { floors: 5, buildings: 3 },
    platinum: { floors: 8, buildings: 6 },
    elite: { floors: 12, buildings: 9 },
    professional: { floors: 30, buildings: 15 },
  };

  const planKey = (premium.premiumType || "").toLowerCase();
  return { Success: true, Message: plans[planKey] || freePlan };
};

// -------------------------------------
// POST /api/building/new
// -------------------------------------
router.post(
  '/api/building/new',
  whoami,
  upload.array('maps'),
  async (req, res) => {
    try {
      /* ───────────────────────── USER CHECK ───────────────────────── */
      const USER = await USERS.findById(req.user._id);
      if (!USER) {
        return res.send({
          Success: false,
          Message: 'User not found.'
        });
      }

      if (!USER.verified) {
        return res.send({
          Success: false,
          Message: 'Verify account first.'
        });
      }

      /* ───────────────────────── BODY VALIDATION ───────────────────────── */
      const { buildingName, floorNames } = req.body;

      if (!buildingName || typeof buildingName !== 'string') {
        return res.send({
          Success: false,
          Message: 'Invalid building name.'
        });
      }

      if (!Array.isArray(floorNames) || floorNames.length === 0) {
        return res.send({
          Success: false,
          Message: 'Invalid floor names.'
        });
      }

      /* ───────────────────────── DUPLICATE FLOOR CHECK ───────────────────────── */
      const normalizedFloors = floorNames.map(name =>
        name.trim().toLowerCase()
      );

      const uniqueFloors = new Set(normalizedFloors);
      if (uniqueFloors.size !== normalizedFloors.length) {
        return res.send({
          Success: false,
          Message: 'Floor names must be unique.'
        });
      }

      /* ───────────────────────── PLAN LIMITS ───────────────────────── */
      const premiumCheck = checkPremiumSettings(USER.premium);
      const maxFloors = premiumCheck.Message.floors;
      const maxBuildings = premiumCheck.Message.buildings;

      if (floorNames.length > maxFloors) {
        return res.send({
          Success: false,
          Message: `Your plan allows up to ${maxFloors} floors.`
        });
      }

      if (USER.Buildings.length >= maxBuildings) {
        return res.send({
          Success: false,
          Message: `Your plan allows up to ${maxBuildings} buildings.`
        });
      }

      /* ───────────────────────── FILE VALIDATION ───────────────────────── */
      const files = req.files || [];

      if (files.length > floorNames.length) {
        return res.send({
          Success: false,
          Message: 'Too many map files uploaded.'
        });
      }

      /* ───────────────────────── MAP + QR GENERATION ───────────────────────── */
      const MAPS = [];

      for (let i = 0; i < floorNames.length; i++) {
        const floorName = floorNames[i];
        const file = files[i]?.path || null;

        const qrCode = await QRCode.toDataURL(
          `http://192.168.100.5:5173/building/${encodeURIComponent(
            buildingName
          )}/${encodeURIComponent(floorName)}`
        );

        MAPS.push({
          floor: floorName,
          map: file,
          qrCode,
          scanned: [],
          createdAt: Date.now()
        });
      }

      /* ───────────────────────── CREATE BUILDING ───────────────────────── */
      const NEW_BUILDING = new BUILDINGS({
        buildingName: buildingName.trim(),
        owner: USER._id,
        floors: floorNames.length,
        maps: MAPS,
        globalScans: [],
        isDeactivated: false,
        updatedAt: Date.now()
      });

      await NEW_BUILDING.save();

      /* ───────────────────────── UPDATE USER ───────────────────────── */
      await USERS.findByIdAndUpdate(USER._id, {
        $push: { Buildings: NEW_BUILDING._id }
      });

      return res.send({
        Success: true,
        Message: 'Building created successfully.',
        buildingID: NEW_BUILDING._id
      });

    } catch (error) {
      console.error(error);
      return res.send({
        Success: false,
        Message: 'Server error.'
      });
    }
  }
);



/* ---------------- UPDATE BUILDING ---------------- */

router.put('/api/building/:id', whoami, upload.array('maps'), async (req, res) => {
  try {
    const user = await USERS.findById(req.user._id);
    const building = await BUILDINGS.findById(req.params.id);

    if (!user || !building) return res.send({ Success: false, Message: 'Not found.' });
    if (building.owner.toString() !== user._id.toString()) {
      return res.send({ Success: false, Message: 'Unauthorized.' });
    }

    let { buildingName, floorNames } = req.body;
    floorNames = normalizeFloorNames(floorNames);

    const nameCheck = await checkBuildingName(user._id, buildingName, building._id);
    if (nameCheck !== true) return res.send({ Success: false, Message: nameCheck });

    const limits = checkPremiumSettings(user.premium);
    if (floorNames.length > limits.floors) {
      return res.send({ Success: false, Message: `Max ${limits.floors} floors allowed.` });
    }

    const files = req.files || [];
    if (files.length !== floorNames.length) {
      return res.send({ Success: false, Message: 'Each floor must have one map.' });
    }

    const MAPS = await Promise.all(
      floorNames.map(async (floor, i) => ({
        floor,
        map: files[i].path,
        qrCode: await QRCode.toDataURL(
          `${process.env.CLIENT_SCAN_QR_URL}?building=${encodeURIComponent(buildingName)}&floor=${encodeURIComponent(floor)}`
        ),
        createdAt: Date.now(),
        scanned: []
      }))
    );

    await BUILDINGS.findByIdAndUpdate(building._id, {
      buildingName,
      maps: MAPS,
      updatedAt: Date.now()
    });

    res.send({ Success: true, Message: 'Building updated.' });
  } catch {
    res.send({ Success: false, Message: 'Server error.' });
  }
});

router.get('/api/building/id/:buildingID', async (req, res) => {
  const { buildingID } = req.params;

  try {
    if (!buildingID) {
      return res.send({
        Success: false,
        Message: "Invalid building ID."
      });
    }

    const BUILDING = await BUILDINGS
      .findById(buildingID)
      .populate("owner", "_id username email");

    if (!BUILDING) {
      return res.send({
        Success: false,
        Message: "Building not found."
      });
    }

    return res.send({
      Success: true,
      Message: BUILDING
    });

  } catch (error) {
    return res.send({
      Success: false,
      Message: "Something went wrong."
    });
  }
});


/* ---------------- GET MY BUILDINGS ---------------- */

router.get("/api/building/my", whoami, async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.send({ Success: false, Message: "User not authenticated" });
    }

    // Fetch all buildings owned by the logged-in user
    const buildings = await BUILDINGS.find({ owner: req.user._id, isDeactivated: false });

    return res.send({ Success: true, Message: buildings });
  } catch (err) {
    console.error(err);
    return res.send({ Success: false, Message: "Server error" });
  }
});

/* ---------------- SCAN ---------------- */

router.get('/api/building/scan/:id/:floor', async (req, res) => {
  console.log(req.params)
  try {
    const building = await BUILDINGS.findById(req.params.id);
    if (!building || building.isDeactivated) {
      return res.send({ Success: false, Message: 'Building not found.' });
    }

    const floorData = building.maps.find(f => f.floor === req.params.floor);
    if (!floorData) {
      return res.send({ Success: false, Message: 'Floor not found.' });
    }

    res.send({
      Success: true,
      Message: {
        buildingName: building.buildingName,
        floorData,
        scannedCount: floorData.scanned.length
      }
    });
  } catch {
    res.send({ Success: false, Message: 'Error.' });
  }
});

router.delete('/api/building', whoami, async (req, res) => {
  const { buildingID } = req.body;

  try {
    // Find building first
    const findBuilding = await BUILDINGS.findOne({
      _id: buildingID,
      owner: req.user._id
    });

    if (!findBuilding) {
      return res.send({ Success: false, Message: "Building not found or not yours." });
    }

    // Find user
    const user = await USERS.findById(req.user._id);
    if (!user) {
      return res.send({ Success: false, Message: "User not found." });
    }

    // Remove building from user's array
    const index = user.Buildings.findIndex(f => f._id.toString() === buildingID);
    if (index !== -1) {
      user.Buildings.splice(index, 1);
      await user.save();
    }

    // Delete the building
    await BUILDINGS.findOneAndDelete({ _id: buildingID, owner: req.user._id });

    return res.send({ Success: true, Message: "Deleted." });
  } catch (err) {
    console.error(err);
    return res.send({ Success: false, Message: "Something went wrong." });
  }
});


router.put('/api/building/deactivate/:id', whoami, async (req, res) => {
  try {
    const building = await BUILDINGS.findOne({ _id: req.params.id, owner: req.user._id });
    if (!building) return res.send({ Success: false, Message: "Building not found." });

    building.isDeactivated = true;
    await building.save();

    res.send({ Success: true, Message: "Building deactivated." });
  } catch (err) {
    console.error("PUT /api/building/deactivate/:id error:", err);
    res.send({ Success: false, Message: "Server error." });
  }
});

export default router;
