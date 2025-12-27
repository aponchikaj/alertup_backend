import express from 'express';
import upload from '../../middlewares/upload.js';
import whoami from '../../middlewares/whoami.js';
import QRCode from 'qrcode';
import USERS from '../../models/user.model.js';
import BUILDINGS from '../../models/building.model.js';
import mongoose from 'mongoose';
import { Filter } from 'bad-words';

const router = express.Router();

/* ---------------- HELPERS ---------------- */

// Check building name validity
const checkBuildingName = async (userID, buildingName, buildingId = null) => {
  if (!userID || !buildingName) return "Something went wrong.";

  buildingName = buildingName.trim();
  if (buildingName.length < 4 || buildingName.length > 40)
    return "Building name must have from 4 to 40 characters.";

  const filter = new Filter();
  if (filter.isProfane(buildingName)) return "Building name contains bad words.";

  const query = { owner: userID, buildingName };
  if (buildingId) query._id = { $ne: buildingId };

  const exists = await BUILDINGS.findOne(query);
  if (exists) return "Building name already exists in your buildings.";

  return true;
};

// Determine max floors & buildings based on plan
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

// Normalize floor names array
const normalizeFloorNames = (floorNames) => {
  if (!Array.isArray(floorNames)) return [];
  return floorNames.map(f => f.trim());
};

/* ---------------- CREATE BUILDING ---------------- */
router.post("/api/building/new", whoami, upload.array("maps"), async (req, res) => {
  try {
    const USER = await USERS.findById(req.user._id);
    if (!USER) return res.send({ Success: false, Message: "User not found." });
    if (!USER.verified) return res.send({ Success: false, Message: "Verify account first." });

    const { buildingName, floorNames } = req.body;
    console.log(buildingName)

    if (!buildingName || typeof buildingName !== "string")
      return res.send({ Success: false, Message: "Invalid building name." });
    if (!Array.isArray(floorNames) || floorNames.length === 0)
      return res.send({ Success: false, Message: "Invalid floor names." });

    const normalizedFloors = floorNames.map(f => f.trim().toLowerCase());
    if (new Set(normalizedFloors).size !== normalizedFloors.length)
      return res.send({ Success: false, Message: "Floor names must be unique." });

    const limits = checkPremiumSettings(USER.premium);
    if (floorNames.length > limits.Message.floors)
      return res.send({ Success: false, Message: `Max ${limits.Message.floors} floors allowed.` });
    if (USER.Buildings.length >= limits.Message.buildings)
      return res.send({ Success: false, Message: `Max ${limits.Message.buildings} buildings allowed.` });

    const nameCheck = await checkBuildingName(USER._id, buildingName);
    if (nameCheck !== true) return res.send({ Success: false, Message: nameCheck });

    const files = req.files || [];
    if (files.length > floorNames.length)
      return res.send({ Success: false, Message: "Too many map files uploaded." });

    const buildingId = new mongoose.Types.ObjectId();
    const MAPS = await Promise.all(
      floorNames.map(async (floor, i) => ({
        floor: floor.trim(),
        map: files[i]?.path || null,
        qrCode: await QRCode.toDataURL(
          `https://www.alertup.world/building/${buildingId}/${encodeURIComponent(floor.trim())}`
        ),
        scanned: 0,
        createdAt: Date.now()
      }))
    );

    const NEW_BUILDING = new BUILDINGS({
      _id: buildingId,
      buildingName: buildingName.trim(),
      owner: USER._id,
      floors: floorNames.length,
      maps: MAPS,
      globalScans: [],
      isDeactivated: false,
      updatedAt: Date.now()
    });

    await NEW_BUILDING.save();

    // Push ObjectId into user.Buildings
    await USERS.findByIdAndUpdate(USER._id, {
      $push: { Buildings: NEW_BUILDING._id }
    });

    return res.send({
      Success: true,
      Message: "Building created successfully.",
      buildingID: NEW_BUILDING._id
    });
  } catch (error) {
    console.error(error);
    return res.send({ Success: false, Message: "Server error." });
  }
});

/* ---------------- UPDATE BUILDING ---------------- */
router.put('/api/building/:id', whoami, upload.array('maps'), async (req, res) => {
  try {
    const user = await USERS.findById(req.user._id);
    const building = await BUILDINGS.findById(req.params.id);

    if (!user || !building) return res.send({ Success: false, Message: 'Not found.' });
    if (building.owner.toString() !== user._id.toString())
      return res.send({ Success: false, Message: 'Unauthorized.' });

    let { buildingName, floorNames } = req.body;
    floorNames = normalizeFloorNames(floorNames);

    const nameCheck = await checkBuildingName(user._id, buildingName, building._id);
    if (nameCheck !== true) return res.send({ Success: false, Message: nameCheck });

    const limits = checkPremiumSettings(user.premium);
    if (floorNames.length > limits.Message.floors)
      return res.send({ Success: false, Message: `Max ${limits.Message.floors} floors allowed.` });

    const files = req.files || [];
    if (files.length !== floorNames.length)
      return res.send({ Success: false, Message: 'Each floor must have one map.' });

    const MAPS = await Promise.all(
      floorNames.map(async (floor, i) => ({
        floor,
        map: files[i]?.path || null,
        qrCode: await QRCode.toDataURL(
          `${process.env.CLIENT_SCAN_QR_URL}?building=${encodeURIComponent(buildingName)}&floor=${encodeURIComponent(floor)}`
        ),
        scanned: 0,
        createdAt: Date.now()
      }))
    );

    await BUILDINGS.findByIdAndUpdate(building._id, {
      buildingName,
      floors: floorNames.length,
      maps: MAPS,
      updatedAt: Date.now()
    });

    res.send({ Success: true, Message: 'Building updated.' });
  } catch (error) {
    console.error(error);
    res.send({ Success: false, Message: 'Server error.' });
  }
});

/* ---------------- GET BUILDING BY ID ---------------- */
router.get('/api/building/id/:buildingID', async (req, res) => {
  const { buildingID } = req.params;

  try {
    // Validate ObjectId
    if (!buildingID || !mongoose.Types.ObjectId.isValid(buildingID)) {
      return res.status(400).send({ Success: false, Message: "Invalid building ID." });
    }

    // Load building and owner info
    const BUILDING = await BUILDINGS.findById(buildingID).populate('owner', '_id username email premium');
    if (!BUILDING) return res.status(404).send({ Success: false, Message: 'Building not found.' });

    const owner = BUILDING.owner;
    if (!owner) return res.status(500).send({ Success: false, Message: 'Owner data missing.' });

    // Check premium expiry and automatically deactivate building if owner's premium expired
    const now = new Date();
    const hasPremium = owner.premium && owner.premium.hasPremium;
    const premiumExpires = owner.premium && owner.premium.to ? new Date(owner.premium.to) : null;

    if (!hasPremium || (premiumExpires && premiumExpires < now)) {
      if (!BUILDING.isDeactivated) {
        BUILDING.isDeactivated = true;
        await BUILDING.save();
        // Send notification email to owner about deactivation and renewal
        try {
          const sendMail = (await import('../../services/sendEmail.js')).default;
          const subject = `Your AlertUp premium expired — ${BUILDING.buildingName} deactivated`;
          const text = `Hello ${owner.username || ''},\n\nYour premium subscription has expired and your building \"${BUILDING.buildingName}\" was deactivated.\n\nTo reactivate premium and restore access to your building, please visit https://www.alertup.world/premium and complete a purchase.\n\nIf you have any questions, reply to this email.`;
          await sendMail(owner.email, subject, text);
        } catch (emailErr) {
          console.error('Failed to send deactivation email:', emailErr);
        }
      }
      return res.send({ Success: false, Message: 'Owner does not have active premium. Building is deactivated.' });
    }

    return res.send({ Success: true, Message: BUILDING });
  } catch (error) {
    console.error('GET /api/building/id/:buildingID error:', error);
    return res.status(500).send({ Success: false, Message: 'Server error.' });
  }
});

/* ---------------- GET MY BUILDINGS ---------------- */
router.get("/api/building/my", whoami, async (req, res) => {
  try {
    if (!req.user || !req.user._id) return res.send({ Success: false, Message: "User not authenticated" });

    const buildings = await BUILDINGS.find({ owner: req.user._id});

    return res.send({ Success: true, Message: buildings });
  } catch (err) {
    console.error(err);
    return res.send({ Success: false, Message: "Server error" });
  }
});

/* ---------------- SCAN FLOOR ---------------- */
router.get('/api/building/scan/:id/:floor', async (req, res) => {
  const { id, floor } = req.params;
  try {
    if (!id || !mongoose.Types.ObjectId.isValid(id)) return res.status(400).send({ Success: false, Message: 'Invalid building id.' });

    // Load building with owner to verify premium status before allowing scan
    const building = await BUILDINGS.findById(id).populate('owner', '_id username email premium');
    if (!building) return res.status(404).send({ Success: false, Message: 'Building not found.' });

    const owner = building.owner;
    if (!owner) return res.status(500).send({ Success: false, Message: 'Owner data missing.' });

    const now = new Date();
    const hasPremium = owner.premium && owner.premium.hasPremium;
    const premiumExpires = owner.premium && owner.premium.to ? new Date(owner.premium.to) : null;

    if (!hasPremium || (premiumExpires && premiumExpires < now)) {
      if (!building.isDeactivated) {
        building.isDeactivated = true;
        await building.save();
        // Send deactivation email to owner
        try {
          const sendMail = (await import('../../services/sendEmail.js')).default;
          const subject = `Your AlertUp premium expired — ${building.buildingName} deactivated`;
          const text = `Hello ${owner.username || ''},\n\nYour premium subscription has expired and your building \"${building.buildingName}\" was deactivated.\n\nTo reactivate premium and restore access to your building, please visit https://www.alertup.world/premium and complete a purchase.\n\nIf you have any questions, reply to this email.`;
          await sendMail(owner.email, subject, text);
        } catch (emailErr) {
          console.error('Failed to send deactivation email on scan:', emailErr);
        }
      }
      return res.status(403).send({ Success: false, Message: 'Building is deactivated due to expired premium.' });
    }

    if (building.isDeactivated) return res.status(403).send({ Success: false, Message: 'Building is deactivated.' });

    // Atomic increment of the scanned counter for the matching floor
    const updated = await BUILDINGS.findOneAndUpdate(
      { _id: id, 'maps.floor': floor },
      { $inc: { 'maps.$[m].scanned': 1 } },
      { arrayFilters: [{ 'm.floor': floor }], new: true }
    );

    if (!updated) return res.status(404).send({ Success: false, Message: 'Floor not found.' });

    const floorData = updated.maps.find(f => f.floor === floor);
    return res.send({ Success: true, Message: { buildingName: updated.buildingName, floorData, scannedCount: floorData.scanned } });
  } catch (error) {
    console.error('GET /api/building/scan/:id/:floor error:', error);
    return res.status(500).send({ Success: false, Message: 'Server error.' });
  }
});


router.get('/api/debug/user-buildings', whoami, async (req, res) => {
  const user = await USERS.findById(req.user._id).select('Buildings');
  res.json({
    buildingsCount: user.Buildings.length,
    buildings: user.Buildings.map(b => b.toString())
  });
});
/* ---------------- DELETE BUILDING ---------------- */
router.delete('/api/building/delete/:buildingID', whoami, async (req, res) => {
  const { buildingID } = req.params;
  
  // Validate ObjectId format first
  if (!mongoose.Types.ObjectId.isValid(buildingID)) {
    return res.status(400).send({ 
      Success: false, 
      Message: "Invalid building ID format." 
    });
  }

  try {
    // First, find the building to ensure it exists and belongs to the user
    const building = await BUILDINGS.findOne({
      _id: buildingID,
      owner: req.user._id
    });

    if (!building) {
      return res.status(404).send({ 
        Success: false, 
        Message: "Building not found or not yours." 
      });
    }

    // Delete the building
    await BUILDINGS.findByIdAndDelete(building._id);

    // Remove from user's Buildings array using the actual building _id
    await USERS.findByIdAndUpdate(
      req.user._id,
      { $pull: { Buildings: building._id } },
      { new: true }
    );

    return res.send({ Success: true, Message: "Building deleted successfully." });
  } catch (err) {
    console.error('❌ Delete Error:', err);
    return res.status(500).send({ Success: false, Message: "Server error." });
  }
});



/* ---------------- DEACTIVATE BUILDING ---------------- */
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
