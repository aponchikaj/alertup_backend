import express from 'express';
const router = express.Router()

import REPORTS from '../../models/report.model';

router.post('/api/report',async(req,res)=>{
    const {email,message,reason} = req.body
    const date = new Date().toISOString()

    try{
        const newReport = await REPORTS({
            reason:reason,
            email:email,
            message:message,
            createdAt:date
        })

        newReport.save()

        return res.send({Success:false,Message:"Sent."})
    }catch{
        return res.send({Success:false,Message:"Server error."})
    }
})

export default router