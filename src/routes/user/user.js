import express from 'express';
const router = express.Router();

import whoami from '../../middlewares/whoami.js';

router.get('/api/me',whoami,async(req,res)=>{
    const ME = req.user;

    if(!req.user){
        return res.send({Success:false,Message:"Unauthorized."})
    }

    return res.send({Success:true,Message:ME})
})

export default router