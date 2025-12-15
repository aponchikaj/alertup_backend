import express from 'express';
const router = express.Router();

import whoami from '../../middlewares/whoami.js';
import USERS from '../../models/user.model.js';


router.get('/api/dashboard',whoami,async(req,res)=>{

    try{
        const USER = await USERS.findById(req.user._id);

        if(!USER){
            return res.send({Success:false,Message:"Something went wrong."})
        }

        return res.send({Success:true,Message:{
            MyBuildings:USER.Buildings.length,
            scanned:USER.scanned.length,
            lastScanned: USER.scanned[USER.scanned.length - 1] || null
        }})
    }catch{
        return res.send({Success:false,Message:'Server error.'})
    }

})

export default router