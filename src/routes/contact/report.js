import express from 'express';
const router = express.Router()

import REPORTS from '../../models/report.model.js';
import { emailLimiter } from '../../services/rateLimiter.js';

const MAX_MESSAGE_LENGTH = 5000;
const MAX_EMAIL_LENGTH = 355;

// This endpoint is unauthenticated and validated nothing — every field was
// optional and unbounded, so a script could fill the reports collection with
// empty documents until the storage quota blew.
router.post('/api/report', emailLimiter, async(req,res)=>{
    const {email,message,reason} = req.body
    const date = new Date().toISOString()

    if(typeof email !== 'string' || typeof message !== 'string' || typeof reason !== 'string'){
        return res.status(400).send({Success:false,Message:"Invalid fields."})
    }
    if(!email.includes('@') || email.length > MAX_EMAIL_LENGTH){
        return res.status(400).send({Success:false,Message:"Invalid email."})
    }
    if(!message.trim() || message.length > MAX_MESSAGE_LENGTH){
        return res.status(400).send({Success:false,Message:"Invalid message."})
    }
    if(!reason.trim() || reason.length > 200){
        return res.status(400).send({Success:false,Message:"Invalid reason."})
    }

    try{
        const newReport = new REPORTS({
            reason:reason,
            email:email.toLowerCase().trim(),
            message:message,
            createdAt:date
        })

        await newReport.save()

        return res.send({Success:true,Message:"Sent."})
    }catch(err){
        console.error('Report submission error:', err)
        return res.status(500).send({Success:false,Message:"Server error."})
    }
})

export default router