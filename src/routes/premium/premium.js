import express from 'express'
const router = express.Router();
import USERS from '../../models/user.model'

const PREMIUM_OPTIONS = {
    Basic:{
        title:"Basic",
        limits:{
            maxFloors:5,
            maxBuildings:4
        }
    }
}

router.get('/api/premium/status',whoami,async(req,res)=>{
    try{
        const user = await USERS.findById(req.user._id);
        if(!user){
            return res.send({Success:false,Message:"Something went wrong."})
        }

        return res.send({Success:true,Message:user.premium})

    }catch{
        return res.send({Success:false,Message:'Server error.'})
    }
})

router.get('/api/premium/options',(req,res)=>{

})

export default router