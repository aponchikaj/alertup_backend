import express from 'express';
const router = express.Router();

import whoami from '../../middlewares/whoami.js';
import USERS from '../../models/user.model.js';
import BUILDINGS from '../../models/building.model.js'

router.get('/api/dashboard',whoami,async(req,res)=>{

    try{
        const USER = await USERS.findById(req.user._id);

        if(!USER){
            return res.send({Success:false,Message:"Something went wrong."})
        }

        const result = await BUILDINGS.aggregate([
        { $match: { owner: USER._id } },
        { $unwind: "$maps" },
        {
            $group: {
            _id: null,
            totalScans: { $sum: "$maps.scanned" }
            }
        }
        ])

        const totalScans = result[0]?.totalScans || 0

        return res.send({Success:true,Message:{
            MyBuildings:USER.Buildings.length,
            scanned:USER.scanned.length,
            lastScanned: USER.scanned[USER.scanned.length - 1] || null,
            myBuildingsScanned: totalScans
        }})
    }catch{
        return res.send({Success:false,Message:'Server error.'})
    }

})

export default router