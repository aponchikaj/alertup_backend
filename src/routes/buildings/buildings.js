import express from 'express';
import upload from '../../middlewares/buildingUpload.js';
import QRCode from 'qrcode';
import USERS from '../../models/user.model.js';
import BUILDINGS from '../../models/building.model.js';
import Floor from '../../models/floor.model.js';
import Node from '../../models/node.model.js';
import QRCodeModel from '../../models/qrcode.model.js';
import mongoose from 'mongoose';
import { uploadToCloudinary } from '../../services/cloudinaryService.js';
import whoami from '../../middlewares/whoami.js';
import fs from 'fs';
import { Filter } from 'bad-words';
import LOGS from '../../models/logs.model.js';

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
const normalizeFloorNames = (floorNames) => {
  if (!Array.isArray(floorNames)) return [];
  return floorNames.map(f => f.trim());
};

/* ---------------- CREATE BUILDING ---------------- */
router.post("/api/building/new", whoami, upload.array("maps"), async (req, res) => {
  try {
    const USER = await USERS.findById(req.user._id);
    if (!USER) return res.send({ Success: false, Message: "User not found." });
    if (USER.verified == false) return res.send({ Success: false, Message: "Verify account first." });

    const { buildingName, floorNames } = req.body;

    if (!buildingName || typeof buildingName !== "string")
      return res.send({ Success: false, Message: "Invalid building name." });
    if (!Array.isArray(floorNames) || floorNames.length === 0)
      return res.send({ Success: false, Message: "Invalid floor names." });

    const normalizedFloors = floorNames.map(f => f.trim().toLowerCase());
    if (new Set(normalizedFloors).size !== normalizedFloors.length)
      return res.send({ Success: false, Message: "Floor names must be unique." });

    // No premium limits - allow unlimited floors and buildings
    const nameCheck = await checkBuildingName(USER._id, buildingName);
    if (nameCheck !== true) return res.send({ Success: false, Message: nameCheck });

    const files = req.files || [];
    if (files.length > floorNames.length)
      return res.send({ Success: false, Message: "Too many map files uploaded." });

    const buildingId = new mongoose.Types.ObjectId();
    const MAPS = await Promise.all(
      floorNames.map(async (floor, i) => {
        let mapUrl = null;
        
        // If there's a file, upload it to Cloudinary
        if (files[i]) {
          try {
            const cloudinaryResult = await uploadToCloudinary(
              fs.readFileSync(files[i].path),
              `alertup/buildings/${buildingId}/floor-${floor.trim()}`
            );
            
            if (cloudinaryResult && cloudinaryResult.secure_url) {
              mapUrl = cloudinaryResult.secure_url;
              
              // Clean up local file after successful upload
              if (files[i].path && fs.existsSync(files[i].path)) {
                fs.unlinkSync(files[i].path);
              }
            }
          } catch (error) {
            console.error(`❌ Failed to upload floor ${floor} map:`, error);
            // Keep local file as fallback
            mapUrl = files[i]?.path || null;
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
              
              // Clean up local file after successful upload
              if (files[i].path && fs.existsSync(files[i].path)) {
                fs.unlinkSync(files[i].path);
              }
            }
          } catch (error) {
            console.error(`❌ Failed to upload floor ${floor} map:`, error);
            // Keep local file as fallback
            mapUrl = files[i]?.path || null;
          }
        }
        
        return {
          floor: floor.trim(),
          map: mapUrl,
          qrCode: await QRCode.toDataURL(
            `${process.env.CLIENT_SCAN_QR_URL}?building=${encodeURIComponent(buildingName)}&floor=${encodeURIComponent(floor)}`
          ),
          scanned: 0,
          createdAt: Date.now()
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
    const BUILDING = await BUILDINGS.findById(buildingID).populate('owner', '_id username email');
    if (!BUILDING) return res.status(404).send({ Success: false, Message: 'Building not found.' });

    const owner = BUILDING.owner;
    if (!owner) return res.status(500).send({ Success: false, Message: 'Owner data missing.' });

    // No premium checks - all buildings are always active
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

    // Load building - no premium checks needed
    const building = await BUILDINGS.findById(id);
    if (!building) return res.status(404).send({ Success: false, Message: 'Building not found.' });

    // No deactivation checks - all buildings are always active
    if (building.isDeactivated) {
      // Reactivate building automatically
      await BUILDINGS.findByIdAndUpdate(id, { isDeactivated: false });
    }

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

    // 1. Delete all nodes for this building
    const nodeDeleteResult = await Node.deleteMany({ buildingId: buildingID });

    // 2. Delete all QR codes for this building
    const qrDeleteResult = await QRCodeModel.deleteMany({ buildingId: buildingID });

    // 3. Delete all floor maps for this building
    const floorDeleteResult = await Floor.deleteMany({ buildingId: buildingID });

    // 4. Update all other nodes that had connections to deleted nodes
    // (This is handled by the node connections cleanup in the node deletion route)
    // But we should also clean up any orphaned connections
    await Node.updateMany(
      { connections: { $exists: true, $ne: [] } },
      { $pull: { connections: { $in: await Node.find({ buildingId: buildingID }).distinct('_id') } } }
    );

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
        qrCodes: qrDeleteResult.deletedCount,
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

    // 2. Delete all QR codes for nodes on this floor
    const qrDeleteResult = await QRCodeModel.deleteMany({ nodeId: { $in: nodeIds } });

    // 3. Delete all nodes on this floor
    const nodeDeleteResult = await Node.deleteMany({ buildingId, floorNumber: floorNum });

    // 4. Clean up connections from other nodes to deleted nodes
    await Node.updateMany(
      { buildingId, connections: { $in: nodeIds } },
      { $pull: { connections: { $in: nodeIds } } }
    );

    // 5. Delete the floor map
    const floorDeleteResult = await Floor.deleteOne({ buildingId, floorNumber: floorNum });

    // 6. Remove floor from building's maps array
    await BUILDINGS.findByIdAndUpdate(
      buildingId,
      { $pull: { maps: { floor: floorNum.toString() } } },
      { new: true }
    );

    return res.send({ 
      Success: true, 
      Message: "Floor and all related data deleted successfully.",
      DeletedCounts: {
        nodes: nodeDeleteResult.deletedCount,
        qrCodes: qrDeleteResult.deletedCount,
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

    // Update or create floor record
    const floorData = await Floor.findOneAndUpdate(
      { buildingId, floorNumber: floorNum },
      {
        buildingId,
        floorNumber: floorNum,
        svgContent: mapData,
        map: mapUrl || `/uploads/floor-maps/${buildingId}-${floorNum}.svg`,
        svgMapUrl: mapUrl,
        width: mapWidth,
        height: mapHeight
      },
      { upsert: true, new: true }
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

    await LOGS.create({
      logType:'system',
      logMessage:"Building has been deactivated.",
      buildingID:building._id,
      isEmergency:true
    })

    res.send({ Success: true, Message: "Building deactivated." });
  } catch (err) {
    console.error("PUT /api/building/deactivate/:id error:", err);
    res.send({ Success: false, Message: "Server error." });
  }
});

router.post('/api/building/evacuated',async(req,res)=>{
  const {buildingID} =req.body;
  try{
    const building = await BUILDINGS.findById(buildingID)
    if(!building) return res.send({Success:false,Message:"Invalid building"});

    await LOGS.create({
      logType:'evacuated',
      logMessage:"Someone has been evacuated successfully",
      buildingID:building._id,
      isEmergency:false
    })

    return res.send({Success:true,Message:"Success."})

  }catch{
    return res.send({Success:false,Message:"Server error."})
  }
})

export default router;
