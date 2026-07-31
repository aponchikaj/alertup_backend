import express from 'express'
import mongoose from 'mongoose'
import LOGS from '../../models/logs.model.js'
import BUILDINGS from '../../models/building.model.js'
import whoami from '../../middlewares/whoami.js'
import EMERGENCIES from '../../models/emergencies.model.js'

const router = express.Router()

router.post('/api/administration/emergency',whoami,async(req,res)=>{
    const {buildingID} =req.body
    if(!buildingID || !mongoose.Types.ObjectId.isValid(buildingID)) return res.status(400).send({Success:false,Message:"Invalid building ID."})
    try{
        const building = await BUILDINGS.findById(buildingID)
        if(!building) return res.status(404).send({Success:false,Message:"Invalid building."})
        if(!building.owner || building.owner.toString() !== req.user._id.toString()) return res.status(403).send({Success:false,Message:"You can't access this function."})

        // Flipped inside the database rather than read-then-written. Reading the
        // current value and writing its negation in a separate round trip meant
        // a double-tapped panic button (or two open tabs) had both requests read
        // `false` and both write `true`, creating two open emergencies — and the
        // close path below only ever finishes one, stranding the other and
        // corrupting the logs feed and analytics.
        const updated = await BUILDINGS.findOneAndUpdate(
            {_id:buildingID, owner:req.user._id},
            [{ $set: { emergencyMode: { $not: "$emergencyMode" } } }],
            {new:true}
        )
        if(!updated) return res.status(404).send({Success:false,Message:"Invalid building."})

        await LOGS.create({
            logType:'emergency',
            logMessage:updated.emergencyMode == true ? "Emergency Mode has been activated." : "Emergency Mode has been deactivated.",
            buildingID:building._id,
            isEmergency:true
        })

        if(updated.emergencyMode == true){
          // Upserted on the open-emergency key so a racing second activation
          // reuses the existing record instead of opening a parallel one.
          await EMERGENCIES.findOneAndUpdate(
            {buildingID:building._id,isFinished:false},
            {$setOnInsert:{buildingID:building._id}},
            {upsert:true,new:true,setDefaultsOnInsert:true}
          )
        }else{
          // updateMany, so any duplicates left behind by the previous race are
          // closed rather than stranded forever.
          await EMERGENCIES.updateMany({buildingID:building._id,isFinished:false},{
            isFinished:true,
            endedAt:new Date()
          })
        }

        return res.send({Success:true,Message:"Saved."})
    }catch(err){
        console.error('Emergency toggle error:', err)
        return res.status(500).send({Success:false,Message:"Server error."})
    }
})

router.get('/api/administration/logs/:id',whoami, async (req, res) => {
  const buildingID = req.params.id
  if (!buildingID) return res.send({ Success: false, Message: "Invalid building ID." })
  
  try {
    const building = await BUILDINGS.findById(buildingID);
    if (!building) {
      return res.send({ Success: false, Message: "Building not found." });
    }

    if (building.owner.toString() !== req.user._id.toString()) {
      return res.send({ Success: false, Message: "Unauthorized." });
    }

    if(building.emergencyMode == false){
      return res.send({Success:false,Message:"Emergency mode is off."})
    }

    const emergency = await EMERGENCIES.findOne({buildingID:building._id,isFinished:false})
    
    if (!emergency) {
      return res.send({ Success: false, Message: "No active emergency found." });
    }

    let logs = await LOGS.find({
      buildingID: building._id,
      isEmergency: true,
      createdAt: { $gte: emergency.startedAt }
    }).sort({ createdAt: 1 });
    
    // logs = logs.filter((log)=>{
    //   return log.createdAt >= emergency.startedAt
    // })

    // if (logs.length === 0) {
    //   return res.send({ Success: false, Message: "Logs not found." });
    // }

    return res.send({ Success: true, Message: logs });
  } catch (err) {
    console.error(err)
    return res.send({ Success: false, Message: "Server error." })
  }
})

router.get('/api/administration/analytics/:buildingID',whoami,async(req,res)=>{
  const {buildingID} = req.params
  if(!buildingID) return res.send({Success:false,Message:"Invalid parameters."})
  const {dateFrom,dateTo} = req.query; // date from da to aris mxolod emergency ebistvis sanam ert ertshi detailed ar shevalt.

  try{
    const building = await BUILDINGS.findById(buildingID)
    if(!building) return res.send({Success:false,Message:"Invalid building ID."})
    if(building.owner.toString() !== req.user._id.toString()) return res.send({Success:false,Message:"You can't access this data."});

    const query = {
      buildingID,
      isFinished: true
    };

    if (dateFrom || dateTo) {
      query.createdAt = {};

      if (dateFrom && !isNaN(new Date(dateFrom))) {
        query.createdAt.$gte = new Date(dateFrom);
      }

      if (dateTo && !isNaN(new Date(dateTo))) {
        query.createdAt.$lte = new Date(dateTo);
      }

      // remove empty createdAt
      if (Object.keys(query.createdAt).length === 0) {
        delete query.createdAt;
      }
    }

    const emergencies = await EMERGENCIES
      .find(query)
      .sort({ createdAt: -1 });

    return res.send({ Success: true, Message: emergencies });
    
  }catch{
    console.error("Error occured while getting analytics.")
    return res.send({Success:false,Message:"Server error."})
  }
})

router.get('/api/administration/analytics/:buildingID/:emergencyID',whoami,async(req,res)=>{
  const {buildingID,emergencyID} = req.params
  if(!buildingID || !emergencyID) return res.status(400).send({Success:false,Message:"Invalid parameters."})
  if(!mongoose.Types.ObjectId.isValid(buildingID) || !mongoose.Types.ObjectId.isValid(emergencyID)){
    return res.status(400).send({Success:false,Message:"Invalid parameters."})
  }
  const {logType,dateFrom,dateTo} = req.query;
  try{
    const building = await BUILDINGS.findById(buildingID)
    if(!building) return res.status(404).send({Success:false,Message:'Invalid building.'});
    if(!building.owner || building.owner.toString() !== req.user._id.toString()) return res.status(403).send({Success:false,Message:"You can't access this."})

    const emergency = await EMERGENCIES.findOne({
      _id: emergencyID,
      buildingID,
      isFinished: true
    }).select('-buildingID')
    // Restored: with this commented out, requesting analytics for an ongoing
    // emergency (excluded by isFinished:true) dereferenced null on the next
    // line, and the catch below never sent a response — so the request hung
    // until the proxy timed out, holding the socket open.
    if(!emergency) return res.status(404).send({Success:false,Message:"Invalid emergency."});

    const STARTED_DATE = dateFrom ? new Date(dateFrom) : emergency.startedAt;
    const FINISHED_DATE = dateTo ? new Date(dateTo) : emergency.endedAt;
    
    if (isNaN(STARTED_DATE.getTime()) || isNaN(FINISHED_DATE.getTime())) {
      return res.status(400).send({ Success: false, Message: "Invalid date format." });
    }
    
    const query = {
      buildingID:building._id,
      createdAt: { $gte: STARTED_DATE, $lte: FINISHED_DATE }
    };

    if (logType) {
      query.logType = logType;
    }

    const logs = await LOGS.find(query);
    
    if (!logs || logs.length === 0) {
      return res.send({ Success: false, Message: "Logs not found." });
    }

    return res.send({Success:true,Message:{logs:logs,emergency:emergency}})
  }catch(e){
    console.error("Error occured while getting emergency analytics.", e)
    // The catch previously only logged, leaving the client waiting forever.
    return res.status(500).send({Success:false,Message:"Server error."})
  }
})

router.post('/api/administration/logs/clear/:id',whoami,async(req,res)=>{
  const buildingID = req.params.id
  if (!buildingID) return res.send({ Success: false, Message: "Invalid building ID." })
  try {
    const building = await BUILDINGS.findOne({_id:buildingID})
    if(!building || building.owner.toString() !== req.user._id.toString()) return res.send({Success:false,Message:"Something went wrong."})
    const result = await LOGS.deleteMany({ buildingID })

    return res.send({
      Success: true,
      Message: `${result.deletedCount} logs deleted`
    })
  } catch (err) {
    console.error(err)
    return res.send({ Success: false, Message: "Server error." })
  }
})

export default router;