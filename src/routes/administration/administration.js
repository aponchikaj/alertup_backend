import express from 'express'
import LOGS from '../../models/logs.model.js'
import BUILDINGS from '../../models/building.model.js'
import whoami from '../../middlewares/whoami.js'
import EMERGENCIES from '../../models/emergencies.model.js'

const router = express.Router()

router.post('/api/administration/emergency',whoami,async(req,res)=>{
    const {buildingID} =req.body
    if(!buildingID) return res.send({Success:false,Message:"Invalid building ID."})
    try{
        const building = await BUILDINGS.findById(buildingID)
        if(!building) return res.send({Success:false,Message:"Invalid building."})
        if(building.owner.toString() !== req.user._id.toString()) return res.send({Success:false,Message:"You can't access this function."})

        const updated = await BUILDINGS.findOneAndUpdate({_id:buildingID},{emergencyMode:building.emergencyMode == false ? true : false},{new:true})
        
        await LOGS.create({
            logType:'emergency',
            logMessage:updated.emergencyMode == true ? "Emergency Mode has been activated." : "Emergency Mode has been deactivated.",
            buildingID:building._id,
            isEmergency:true
        })

        if(updated.emergencyMode == true){
          await EMERGENCIES.create({
            buildingID:building._id,
          })
        }else if(updated.emergencyMode == false){
          await EMERGENCIES.findOneAndUpdate({buildingID:building._id,isFinished:false},{
            isFinished:true,
            endedAt:new Date()
          },{new:true})
        }

        return res.send({Success:true,Message:"Saved."})
    }catch{
        return res.send({Success:false,Message:"Server error."})
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

    if (logs.length === 0) {
      return res.send({ Success: false, Message: "Logs not found." });
    }

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
  const {buildingID,emergencyID} = req.params;
  if(!buildingID || !emergencyID) return res.send({Success:false,Message:"Invalid parameters."})
  const {logType,dateFrom,dateTo} = req.query;
  try{
    const building = await BUILDINGS.findById(buildingID)
    if(!building) return res.send({Success:false,Message:'Invalid building.'});
    if(building.owner.toString() !== req.user._id.toString()) return res.send({Success:false,Message:"You can't access this."})

    const emergency = await EMERGENCIES.find({_id:emergencyID,buildingID:buildingID,isFinished:true}).select('-buildingID');
    if(!emergency) return res.send({Success:false,Message:"Invalid emergency."});

    const STARTED_DATE = dateFrom ? new Date(dateFrom) : emergency.startedAt;
    const FINISHED_DATE = dateTo ? new Date(dateTo) : emergency.endedAt;
    
    if (isNaN(STARTED_DATE.getTime()) || isNaN(FINISHED_DATE.getTime())) {
      return res.status(400).send({ Success: false, Message: "Invalid date format." });
    }
    
    const query = {
      buildingID,
      createdAt: { $gte: STARTED_DATE, $lte: FINISHED_DATE }
    };

    if (logType) {
      query.logType = logType;
    }

    const logs = await LOGS.find(query);
    
    if (!logs || logs.length === 0) {
      return res.status(404).send({ Success: false, Message: "Logs not found." });
    }

    return res.send({Success:true,Message:{logs:logs,emergency:emergency}})
  }catch{
    console.log("Error occured while getting emergency analytics.")
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