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
        await newContact.save()
        res.send({Success:true,Message:"Sent."})
        try {
            const contactHTML = `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
                <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                  <h1 style="color: #FF7B22; margin-top: 0;">📧 New Contact Message</h1>
                  <p style="color: #333; font-size: 16px;">You have received a new message from AlertUp contact form.</p>
                  <div style="background-color: #f9f9f9; padding: 20px; border-radius: 5px; margin: 20px 0;">
                    <p style="margin: 0 0 10px 0; color: #666;"><strong style="color: #333;">From:</strong> ${email}</p>
                    <p style="margin: 0 0 10px 0; color: #666;"><strong style="color: #333;">Reason:</strong> ${reason}</p>
                    <p style="margin: 0 0 10px 0; color: #666;"><strong style="color: #333;">Date:</strong> ${new Date(date).toLocaleString()}</p>
                    <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #ddd;">
                      <p style="margin: 0 0 5px 0; color: #333; font-weight: bold;">Message:</p>
                      <p style="margin: 0; color: #666; white-space: pre-wrap;">${message}</p>
                    </div>
                  </div>
                  <p style="color: #666; font-size: 14px; margin-top: 20px;">Best regards,<br><strong style="color: #FF7B22;">AlertUp Contact System</strong></p>
                </div>
              </div>
            `;
            await sendMail(process.env.GMAIL_USER,'New Message - Alertup',`Author: ${email}, Reason: ${reason}, Message: ${message}. ${date}`, undefined, contactHTML)
        } catch (err) {
            console.error("MAIL ERROR:", err);
        }
    }catch{
        return res.send({Success:false,Message:"Server error."})
    }
})

export default router