import express from 'express'
const router = express.Router()

import bcrypt from 'bcrypt'

import USERS from '../../models/user.model'
// import VEFIFICATIONS from '../../models/verificatios.model'
import VERIFICATIONS from '../../models/verificatios.model'
import sendMail from '../../services/sendEmail'

const findUSER = async(user)=>{
    try{    
        let USER;
        if(user.includes('@')){
            USER = await USERS.findOne({email:user})
        }else if(!user.includes('@')){
            USER = await USERS.findOne({username:user})
        }

        if(!USER){
            return {Success:false,Message:"User not found."}
        }

        return {Success:true,Message:USER}
    }catch{
        return "Server error."
    }
}

router.post('/api/reset/send-code',async(req,res)=>{
    const {user} = req.body

    if(!user){
        return res.send({Success:false,Message:"Invalid user."})
    }

    try{
        const userData = await findUSER(user)

        if(!userData.Success){
            return res.send({Success:false,Message:USER.Message})
        }

        const USER = userData.Message

        //check if already sent.
        const findVerification = await VERIFICATIONS.findOne({verificationBy:USER._id})

        if(findVerification){
            await VERIFICATIONS.findOneAndDelete({verificationBy:USER._id});
        }

        const CODE = Math.floor(Math.random()*(999999-100000)+100000)

        const newVerificationConfig = {
            verificationBy:USER._id,
            verificationType:'reset',
            verificationCode:CODE
        }

        await sendMail(USER.email,'Reset password - AlertUp',`Hello ${USER.username}. Here is your Password reset verification code: ${CODE}. wasn't you? contact us and we will figure it out.`)

        const newVerification = await VERIFICATIONS(newVerificationConfig);
        await newVerification.save()

        return res.send({Success:true,Message:'Sent.'})

    }catch{
        return res.send({Success:false,Message:'Server error.'})
    }
})

router.post('/api/reset/verify-code',async(req,res)=>{
    const {user,code}=req.body

    if(!user||!code){
        return res.send({Success:false,Message:"Invalid fields."})
    }

    try{
        const userdata = await findUSER(user)
        if(!userdata.Success){
            return res.send({Success:false,Message:userdata.Message})
        }

        const USER = userdata.Message;

        const findVerification = await VERIFICATIONS.findOne({verificationBy:USER._id})
        if(!findVerification){
            await VERIFICATIONS.findOneAndDelete({verificationBy:USER._id})
            return res.send({Success:false,Message:"Expired or invalid code."})
        }

        if(findVerification && findVerification.expires>Date.now()){
            await VERIFICATIONS.findOneAndDelete({verificationBy:USER._id})
            return res.send({Success:false,Message:"Expired code."})
        }
        
        if(findVerification && findVerification.expires < Date.now() && findVerification.verificationCode !== Number(code)){
            return res.send({Success:false,Message:'Invalid code.'})
        }   

        if(await USERS.findOne({_id:USER._id}).verified == false){
            await USERS.findOneAndUpdate({_id:USER._id},{verified:true},{new:true})
            await sendMail(USER.email,"Account Verified - AlertUp",`Hello again ${USER.username}. We saw that you have entered your password reset verification code correctly and your mail was not verified. so we've decided to make your account verified. Congrats. if it wasn't you contact us right away. `)
        }

        await VERIFICATIONS.findOneAndDelete({verificationBy:USER._id})
        return res.send({Success:true})
    }catch{
        return res.send({Success:true,Message:"Server error."})
    }
})

router.post('/api/reset/password',async(req,res)=>{
    const {user,newPassword} = req.body;

    try{
        const userData = await findUSER(user);

        if(!userData.Success){
            return res.send({Success:false,Message:userData.Message})
        }

        const USER = userData.Message
        const USER_ID  = USER._id;
        const newPass = await bcrypt.hash(newPassword,10)
        await USERS.findOneAndUpdate({_id:USER_ID},{password:newPass},{new:true})

        return res.send({Success:true,Message:"Password has been changed."})
    }catch{
        return res.send({Success:false,Message:"Server error."})
    }
})

export default router