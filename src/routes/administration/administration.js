import express from 'express'
import LOGS from '../../models/logs.model.js'
import BUILDINGS from '../../models/building.model.js'
import whoami from '../../middlewares/whoami.js'

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

        return res.send({Success:true,Message:"Saved."})
    }catch{
        return res.send({Success:false,Message:"Server error."})
    }
})

router.get('/api/administration/logs/:id',whoami, async (req, res) => {
  const buildingID = req.params.id
  if (!buildingID) return res.send({ Success: false, Message: "Invalid building ID." })

  try {
    const building = await BUILDINGS.findById(buildingID)
    if(!building || building.owner.toString() !== req.user._id.toString()) return res.send({Success:false,Message:"Something went wrong."})
    let findLogs = await LOGS.find({ buildingID })
    findLogs.sort((a, b) => a.createdAt - b.createdAt)
    return res.send({ Success: true, Message: findLogs })
  } catch (err) {
    console.error(err)
    return res.send({ Success: false, Message: "Server error." })
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