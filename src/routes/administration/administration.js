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

        await BUILDINGS.findOneAndUpdate({_id:buildingID},{emergencyMode:building.emergencyMode == false ? true : false},{new:true})
        await LOGS.create({
            logType:'emergency',
            logMessage:"Emergency Mode has been activated.",
            buildingID:building._id,
            isEmergency:true
        })

        return res.send({Success:true,Message:"Saved."})
    }catch{
        return res.send({Success:false,Message:"Server error."})
    }
})

router.get('/api/administration/logs',async(req,res)=>{
    
})

export default router;