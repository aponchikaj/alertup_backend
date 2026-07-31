import express from 'express';
import upload from '../../middlewares/buildingUpload.js';
import QRCode from 'qrcode';
import USERS from '../../models/user.model.js';
import BUILDINGS from '../../models/building.model.js';
import Floor from '../../models/floor.model.js';
import Node from '../../models/node.model.js';
import mongoose from 'mongoose';
import { uploadToCloudinary } from '../../services/cloudinaryService.js';
import whoami from '../../middlewares/whoami.js';
import fs from 'fs';
import { Filter } from 'bad-words';
import LOGS from '../../models/logs.model.js';
import jwt from 'jsonwebtoken'
import EMERGENCIES from '../../models/emergencies.model.js';
import { displayName } from '../../services/displayName.js';
import { emergencyActionLimiter, publicReadLimiter } from '../../services/rateLimiter.js';

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

// Normalize floor names array
/**
 * Coerce the floorNames field to an array of trimmed strings.
 *
 * In a multipart request a field sent exactly once arrives as a bare string,
 * not a one-element array, so single-floor buildings were rejected outright
 * unless the client happened to use `floorNames[]` bracket notation.
 */
const normalizeFloorNames = (floorNames) => {
  if (floorNames === undefined || floorNames === null) return [];
  const list = Array.isArray(floorNames) ? floorNames : [floorNames];
  return list.filter((f) => typeof f === 'string').map((f) => f.trim()).filter(Boolean);
};

/* ---------------- CREATE BUILDING ---------------- */
router.post("/api/building/new", whoami, upload.array("maps"), async (req, res) => {
  const uploadedFiles = []; // Track all uploaded files for cleanup
  try {
    const USER = await USERS.findById(req.user._id);
    if (!USER) return res.send({ Success: false, Message: "User not found." });
    if (USER.verified == false) return res.send({ Success: false, Message: "Verify account first." });
    
    const { buildingName } = req.body;
    if (!buildingName || typeof buildingName !== "string")
      return res.send({ Success: false, Message: "Invalid building name." });
    // Normalized first: a single floor arrives as a string in multipart, which
    // the previous Array.isArray check rejected.
    const floorNames = normalizeFloorNames(req.body.floorNames);
    if (floorNames.length === 0)
      return res.send({ Success: false, Message: "Invalid floor names." });

    const normalizedFloors = floorNames.map(f => f.trim().toLowerCase());
    if (new Set(normalizedFloors).size !== normalizedFloors.length)
      return res.send({ Success: false, Message: "Floor names must be unique." });
    
    const nameCheck = await checkBuildingName(USER._id, buildingName);
    if (nameCheck !== true) return res.send({ Success: false, Message: nameCheck });
    
    const files = req.files || [];
    
    // Store file paths for cleanup
    uploadedFiles.push(...files.map(f => f.path));
    
    if (files.length > floorNames.length)
      return res.send({ Success: false, Message: "Too many map files uploaded." });
    
    const buildingId = new mongoose.Types.ObjectId();
    
    const MAPS = await Promise.all(
      floorNames.map(async (floor, i) => {
        let mapUrl = null;
        
        if (files[i]) {
          try {
            const cloudinaryResult = await uploadToCloudinary(
              fs.readFileSync(files[i].path),
              `alertup/buildings/${buildingId}/floor-${floor.trim()}`
            );
            if (cloudinaryResult && cloudinaryResult.secure_url) {
              mapUrl = cloudinaryResult.secure_url;
            }
          } catch (error) {
            console.error(`❌ Failed to upload floor ${floor} map:`, error);
            // Don't use local path as fallback - just set to null
            mapUrl = null;
          }
        }
        
        return {
          floor: floor.trim(),
          map: mapUrl,
          qrCode: await QRCode.toDataURL(
            `https://www.alertup.world/building/${buildingId}/${encodeURIComponent(floor.trim())}`
          ),
          scanned: 0,
          createdAt: Date.now()
        };
      })
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
  }finally{
    uploadedFiles.forEach(filePath => {
      if (filePath && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (err) {
          console.error(`Failed to delete file ${filePath}:`, err);
        }
      }
    });
  }
});

/* ---------------- UPDATE BUILDING ---------------- */
router.put('/api/building/:id', whoami, upload.array('maps'), async (req, res) => {
  // Collected up front so the finally block can clean up on every exit path.
  // The early returns below used to leave their temp files behind, growing
  // uploads/buildings/ until the disk filled.
  const uploadedFiles = (req.files || []).map((f) => f.path).filter(Boolean);
  try {
    const user = await USERS.findById(req.user._id);
    const building = await BUILDINGS.findById(req.params.id);

    if (!user || !building) return res.status(404).send({ Success: false, Message: 'Not found.' });
    if (!building.owner || building.owner.toString() !== user._id.toString())
      return res.status(403).send({ Success: false, Message: 'Unauthorized.' });

    let { buildingName, floorNames } = req.body;
    floorNames = normalizeFloorNames(floorNames);

    const nameCheck = await checkBuildingName(user._id, buildingName, building._id);
    if (nameCheck !== true) return res.send({ Success: false, Message: nameCheck });

    // No premium limits - allow unlimited floors
    const files = req.files || [];
    if (files.length !== floorNames.length)
      return res.send({ Success: false, Message: 'Each floor must have one map.' });

    const MAPS = await Promise.all(
      floorNames.map(async (floor, i) => {
        let mapUrl = null;

        // If there's a file, upload it to Cloudinary
        if (files[i]) {
          try {
            const cloudinaryResult = await uploadToCloudinary(
              fs.readFileSync(files[i].path),
              `alertup/buildings/${building._id}/floor-${floor.trim()}`
            );

            if (cloudinaryResult && cloudinaryResult.secure_url) {
              mapUrl = cloudinaryResult.secure_url;
            }
          } catch (error) {
            console.error(`❌ Failed to upload floor ${floor} map:`, error);
            // null, matching the create route. Storing files[i].path here put an
            // absolute server path into the document, which leaked the
            // filesystem layout through the public building endpoint and became
            // a broken image URL for anyone scanning during an emergency.
            mapUrl = null;
          }
        }

        const floorName = floor.trim();
        // Carried over so editing a building does not reset its scan history.
        const existing = building.maps?.find((m) => m.floor === floorName);

        return {
          floor: floorName,
          map: mapUrl,
          // Same URL shape the create route uses. This route used to build a
          // CLIENT_SCAN_QR_URL query keyed on the building *name*, which no
          // backend route can resolve — and encoded the literal string
          // "undefined" whenever that variable was unset — so every QR code
          // reprinted after an edit stopped working.
          qrCode: await QRCode.toDataURL(
            `https://www.alertup.world/building/${building._id}/${encodeURIComponent(floorName)}`
          ),
          scanned: existing?.scanned || 0,
          createdAt: existing?.createdAt || Date.now()
        };
      })
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
    res.status(500).send({ Success: false, Message: 'Server error.' });
  } finally {
    uploadedFiles.forEach((filePath) => {
      if (filePath && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (err) {
          console.error(`Failed to delete file ${filePath}:`, err);
        }
      }
    });
  }
});

/* ---------------- GET BUILDING BY ID ---------------- */
// Public on purpose: an occupant scanning a QR has no account, and the
// frontend BuildingOwnerGuard compares `Message.owner` against the current
// user id. So the building stays readable, but the owner is reduced to an id
// plus a display name — never their email, phone, transactions, trusted IPs,
// or scan history.
router.get('/api/building/id/:buildingID', async (req, res) => {
  const { buildingID } = req.params;

  try {
    if (!buildingID || !mongoose.Types.ObjectId.isValid(buildingID)) {
      return res.send({ Success: false, Message: "Invalid building ID." });
    }

    const BUILDING = await BUILDINGS.findById(buildingID)
      .select('buildingName owner floors maps globalScans emergencyMode isDeactivated createdAt updatedAt')
      .lean();
    if (!BUILDING) return res.send({ Success: false, Message: 'Building not found.' });

    const owner = await USERS.findById(BUILDING.owner)
      .select('_id name lastname company userType')
      .lean();
    if (!owner) return res.send({ Success: false, Message: 'Owner data missing.' });

    return res.send({
      Success: true,
      Message: BUILDING,
      Owner: {
        _id: owner._id,
        displayName: displayName(owner),
        userType: owner.userType,
      },
    });

  } catch (error) {
    console.error('GET /api/building/id/:buildingID error:', error);
    return res.send({ Success: false, Message: 'Server error.' });
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
router.get('/api/building/scan/:id/:floor', publicReadLimiter, async (req, res) => {
  const { id, floor } = req.params;
  try {
    if (!id || !mongoose.Types.ObjectId.isValid(id)) return res.status(400).send({ Success: false, Message: 'Invalid building id.' });

    // Load building - no premium checks needed
    const building = await BUILDINGS.findById(id);
    if (!building) return res.status(404).send({ Success: false, Message: 'Building not found.' });

    // A deactivated building is honored rather than silently switched back on.
    // This endpoint is anonymous, so reactivating here let any passer-by undo
    // the owner-only deactivation and get served stale evacuation data.
    if (building.isDeactivated) {
      return res.status(410).send({ Success: false, Message: 'This building is currently deactivated.' });
    }

    // Atomic increment of the scanned counter for the matching floor
    const updated = await BUILDINGS.findOneAndUpdate(
      { _id: id, 'maps.floor': floor },
      { $inc: { 'maps.$[m].scanned': 1 } },
      { arrayFilters: [{ 'm.floor': floor }], new: true }
    );

    if (!updated) return res.status(404).send({ Success: false, Message: 'Floor not found.' });

    if(updated.emergencyMode==true){
      await LOGS.create({
        logType:"scan",
        logMessage:"Floor QR has been scanned.",
        buildingID:building._id,
        isEmergency:building.emergencyMode
      })
      // await EMERGENCIES.findOneAndUpdate({buildingID:building._id,isFinished:false},{$inc:{scanned:1}},{new:true})
    }

    // Same reasoning as the QR scan route: an invalid token must not turn a
    // successful floor lookup into a 500 for the person standing in the building.
    const userToken = req.cookies['userToken']
    if (userToken) {
      try {
        const decoded = jwt.verify(userToken, process.env.JWT_SECRET)
        await USERS.findOneAndUpdate(
          { _id: decoded.userID },
          { $push: { scanned: { buildingName: building.buildingName, scannedAt: Date.now(), buildingID: building._id } } },
          { new: true }
        )
      } catch (tokenErr) {
        console.warn('Scan history not recorded (invalid token):', tokenErr.message)
      }
    }


    const floorData = updated.maps.find(f => f.floor === floor);
    return res.send({ Success: true, Message: { buildingName: updated.buildingName, floorData, scannedCount: floorData.scanned } });
  } catch (error) {
    console.error('GET /api/building/scan/:id/:floor error:', error);
    return res.status(500).send({ Success: false, Message: 'Server error.' });
  }
});


// The /api/debug/user-buildings endpoint was removed: it duplicated
// /api/building/my, was registered unconditionally in production, and had no
// try/catch, so any database error there reached Express's default HTML
// handler.

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

    // 1. Collect the node ids BEFORE deleting them. The previous version ran
    //    this query after the delete, so it always came back empty and the
    //    orphaned-connection cleanup below silently did nothing.
    const nodeIds = await Node.find({ buildingId: buildingID }).distinct('_id');

    // 2. Delete all nodes for this building
    const nodeDeleteResult = await Node.deleteMany({ buildingId: buildingID });

    // 3. Delete all floor maps for this building
    const floorDeleteResult = await Floor.deleteMany({ buildingId: buildingID });

    // 4. Drop any remaining edges pointing at the deleted nodes
    if (nodeIds.length) {
      await Node.updateMany(
        { connections: { $in: nodeIds } },
        { $pull: { connections: { $in: nodeIds } } }
      );
    }

    // 5. Delete the building itself
    await BUILDINGS.findByIdAndDelete(building._id);

    // 6. Remove from user's Buildings array using the actual building _id
    await USERS.findByIdAndUpdate(
      req.user._id,
      { $pull: { Buildings: building._id } },
      { new: true }
    );

    return res.send({
      Success: true,
      Message: "Building and all related data deleted successfully.",
      DeletedCounts: {
        nodes: nodeDeleteResult.deletedCount,
        floors: floorDeleteResult.deletedCount
      }
    });
  } catch (err) {
    console.error('❌ Delete Error:', err);
    return res.status(500).send({ Success: false, Message: "Server error." });
  }
});

/* ---------------- DELETE FLOOR ---------------- */
router.delete('/api/building/:buildingId/floor/:floorNumber', whoami, async (req, res) => {
  const { buildingId, floorNumber } = req.params;
  
  // Validate ObjectId format
  if (!mongoose.Types.ObjectId.isValid(buildingId)) {
    return res.status(400).send({ 
      Success: false, 
      Message: "Invalid building ID format." 
    });
  }

  // Validate floor number
  const floorNum = parseInt(floorNumber, 10);
  if (isNaN(floorNum) || floorNum < 1) {
    return res.status(400).send({ 
      Success: false, 
      Message: "Invalid floor number." 
    });
  }

  try {
    // Check if building exists and belongs to user
    const building = await BUILDINGS.findOne({
      _id: buildingId,
      owner: req.user._id
    });

    if (!building) {
      return res.status(404).send({ 
        Success: false, 
        Message: "Building not found or not yours." 
      });
    }

    // 1. Find all nodes on this floor
    const floorNodes = await Node.find({ buildingId, floorNumber: floorNum });
    const nodeIds = floorNodes.map(node => node._id);

    // 2. Delete all nodes on this floor
    const nodeDeleteResult = await Node.deleteMany({ buildingId, floorNumber: floorNum });

    // 4. Clean up connections from other nodes to deleted nodes
    await Node.updateMany(
      { buildingId, connections: { $in: nodeIds } },
      { $pull: { connections: { $in: nodeIds } } }
    );

    // 5. Delete the floor map
    const floorDeleteResult = await Floor.deleteOne({ buildingId, floorNumber: floorNum });

    // 6. Remove floor from building's maps array.
    //    Matched by index rather than by name: buildings may use arbitrary
    //    floor names ("Ground", "Mezzanine"), and comparing against
    //    floorNum.toString() could never remove those entries.
    const remainingMaps = building.maps.filter((_, index) => index + 1 !== floorNum);

    // 7. Keep the floors count in step with the maps that are actually left.
    //    It was never decremented, so it drifted upward on every deletion.
    await BUILDINGS.findByIdAndUpdate(
      buildingId,
      { maps: remainingMaps, floors: remainingMaps.length, updatedAt: Date.now() },
      { new: true }
    );

    return res.send({
      Success: true,
      Message: "Floor and all related data deleted successfully.",
      DeletedCounts: {
        nodes: nodeDeleteResult.deletedCount,
        floorMap: floorDeleteResult.deletedCount
      }
    });
  } catch (err) {
    console.error('❌ Floor Delete Error:', err);
    return res.status(500).send({ Success: false, Message: "Server error." });
  }
});


/* ---------------- UPDATE FLOOR MAP ---------------- */
router.put('/api/building/:buildingId/floor/:floorNumber/map', whoami, async (req, res) => {
  try {
    const { buildingId, floorNumber } = req.params;
    const { svgContent, svgMapUrl, width, height } = req.body;

    // Validate building ID
    if (!buildingId || !mongoose.Types.ObjectId.isValid(buildingId)) {
      return res.status(400).json({ Success: false, Message: 'Invalid building ID.' });
    }

    // Validate floor number
    const floorNum = parseInt(floorNumber, 10);
    if (isNaN(floorNum) || floorNum < 1) {
      return res.status(400).json({ Success: false, Message: 'Invalid floor number.' });
    }

    // Check if user owns the building
    const building = await BUILDINGS.findOne({ _id: buildingId, owner: req.user._id });
    if (!building) {
      return res.status(404).json({ Success: false, Message: 'Building not found or unauthorized.' });
    }

    let mapData = svgContent;
    let mapUrl = svgMapUrl;

    // If SVG content is provided, upload to Cloudinary
    if (svgContent && typeof svgContent === 'string') {
      try {
        const cloudinaryResult = await uploadToCloudinary(
          Buffer.from(svgContent),
          `alertup/buildings/${buildingId}/floor-${floorNum}`
        );
        
        if (cloudinaryResult && cloudinaryResult.secure_url) {
          mapUrl = cloudinaryResult.secure_url;
        }
      } catch (cloudinaryError) {
        console.error('❌ Cloudinary upload failed:', cloudinaryError);
        return res.status(500).json({
          Success: false,
          Message: 'Failed to upload SVG to Cloudinary'
        });
      }
    }

    // Validate dimensions
    const mapWidth = parseInt(width) || 1000;
    const mapHeight = parseInt(height) || 800;

    // svgMapUrl is required by the Floor schema, so a request carrying only
    // svgContent (or neither) would upsert an invalid document — silently,
    // because the upsert ran without validators.
    if (!mapUrl) {
      return res.status(400).json({
        Success: false,
        Message: 'A floor map requires either svgContent or svgMapUrl.'
      });
    }

    // Update or create floor record.
    // The former `map` field does not exist on the Floor schema, so Mongoose
    // stripped it — and its fallback pointed at /uploads/floor-maps/..., a path
    // nothing in the application ever writes.
    const floorData = await Floor.findOneAndUpdate(
      { buildingId, floorNumber: floorNum },
      {
        buildingId,
        floorNumber: floorNum,
        svgContent: mapData,
        svgMapUrl: mapUrl,
        width: mapWidth,
        height: mapHeight
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );

    return res.json({
      Success: true,
      Message: 'Floor map updated successfully.',
      Data: {
        floorNumber: floorNum,
        mapUrl: mapUrl,
        width: mapWidth,
        height: mapHeight
      }
    });

  } catch (error) {
    console.error('Error updating floor map:', error);
    return res.status(500).json({
      Success: false,
      Message: 'Server error while updating floor map.'
    });
  }
});

/* ---------------- DEACTIVATE BUILDING ---------------- */
router.put('/api/building/deactivate/:id', whoami, async (req, res) => {
  try {
    const building = await BUILDINGS.findOne({ _id: req.params.id, owner: req.user._id });
    if (!building) return res.send({ Success: false, Message: "Building not found." });

    building.isDeactivated = true;
    await building.save();

    if(building.emergencyMode == true){
      await LOGS.create({
        logType:'system',
        logMessage:"Building has been deactivated.",
        buildingID:building._id,
        isEmergency:true
      })
    }

    res.send({ Success: true, Message: "Building deactivated." });
  } catch (err) {
    console.error("PUT /api/building/deactivate/:id error:", err);
    res.send({ Success: false, Message: "Server error." });
  }
});

// Anonymous on purpose: the person evacuating a burning building does not have
// an account. Throttled per IP instead of authenticated.
router.post('/api/building/evacuated', emergencyActionLimiter, async(req,res)=>{
  const {buildingId} =req.body;
  try{
    if(!buildingId || !mongoose.Types.ObjectId.isValid(buildingId)){
      return res.send({Success:false,Message:"Invalid building"});
    }
    const building = await BUILDINGS.findById(buildingId)
    if(!building) return res.send({Success:false,Message:"Invalid building"});

    if(building.emergencyMode == true){
      await LOGS.create({
        logType:'evacuated',
        logMessage:"Someone has been evacuated successfully",
        buildingID:building._id,
        isEmergency:building.emergencyMode
      })
      await EMERGENCIES.findOneAndUpdate({buildingID:building._id,isFinished:false},{$inc:{evacuated:1}},{new:true});
    }
    
    return res.send({Success:true,Message:"Success."})
  }catch{
    return res.send({Success:false,Message:"Server error."})
  }
})

// Anonymous on purpose, same reasoning as /evacuated above.
router.post('/api/building/emergencyCall', emergencyActionLimiter, async(req,res)=>{
  const {buildingID} = req.body;
  try{
    if(!buildingID || !mongoose.Types.ObjectId.isValid(buildingID)){
      return res.send({Success:false,Message:"Invalid building."});
    }

    const building = await BUILDINGS.findById(buildingID)
    if(!building) return res.send({Success:false,Message:"Invalid building."});

    await LOGS.create({
      logType:'system',
      logMessage:"+1 user called ambulance",
      buildingID:building._id,
      isEmergency:true
    })
    await EMERGENCIES.findOneAndUpdate({buildingID:building._id,isFinished:false},{$inc:{calledEmergency:1}},{new:true})

    return res.send({Success:true,Message:"Recorded."})
  }catch(err){
    console.error("Error occured while trying to call ambulance.", err)
    return res.send({Success:false,Message:"Server error."})
  }
})

export default router;
