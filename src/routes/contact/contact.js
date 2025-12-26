import express from 'express'
const router = express.Router()

import CONTACTS from '../../models/contact.model.js';
import sendMail from '../../services/sendEmail.js'

router.post('/api/contact',async(req,res)=>{
    const {email,message,reason} = req.body;
    const date = new Date().toISOString()

    if(!email || !message || !reason ){
        return res.send({Success:false,Message:"Invalid fields."})
    }

    try{
        if(!email.includes('@')){
            return res.send({Success:false,Message:"Invalid Email."})
        }
        const newContact = await CONTACTS({
            email:email,
            message:message,
            contactType:reason,
            createdAt:date
        })
        newContact.save()
        try {
            await sendMail(process.env.GMAIL_USER,'New Message - Alertup',`Author: ${email}, Reason: ${reason}, Message: ${message}. ${date}`)
        } catch (err) {
            console.error("MAIL ERROR:", err);
        }
        return res.send({Success:true,Message:"Sent."})
    }catch{
        return res.send({Success:false,Message:"Server error."})
    }
})

export default router