import express from 'express'
const router = express.Router()

import CONTACTS from '../../models/contact.model';

router.post('/api/contact',async(req,res)=>{
    const {email,message,reason} = req.body;
    const date = new Date().toISOString()

    try{
        const newContact = await CONTACTS({
            email:email,
            message:message,
            contactType:reason,
            createdAt:date
        })

        newContact.save()

        return res.send({Success:true,Message:"Sent."})
    }catch{
        return res.send({Success:false,Message:"Server error."})
    }
})

export default router