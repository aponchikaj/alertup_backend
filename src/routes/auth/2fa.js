import express from "express";
import USERS from "../../models/user.model";
import VERIFICATIONS from '../../models/verificatios.model'
import sendMail from '../../services/sendEmail';
import whoami from '../../middlewares/whoami'
import bcrypt from 'bcrypt'

const router = express.Router()

router.post('/api/2fa/activate',whoami,async(req,res)=>{
    // making new verification + code and sending it to users email and sending response
    try{
        const FIND_VERIFICATION = await VERIFICATIONS.findOne({verificationBy:req.user._id,verificationType:"2fa-activation"});
        if(FIND_VERIFICATION) {
            await VERIFICATIONS.findOneAndDelete({verificationBy:req.user._id,verificationType:"2fa-activation"})
        }

        const VERIFICATION_CODE = Math.floor(Math.random()*(999999-100000)+100000)
        const hashedCode = await bcrypt.hash(String(VERIFICATION_CODE),12)
        const VERIFICATION_CONFIG = {
            verificationBy:req.user._id,
            verificationCode:hashedCode,
            verificationType:"2fa-activation"
        }

        await VERIFICATIONS.create(VERIFICATION_CONFIG)

        try{
            const displayName = req.user.userType === "Individual" ? req.user.name : req.user.company;

            const twoFAText = `Hey ${displayName}, your two-factor authentication code is: ${VERIFICATION_CODE}. This code will expire in 5 minutes.`;

            const twoFAHTML = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
                    <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                    <h1 style="color: #FF7B22; margin-top: 0;">🔐 Two-Factor Authentication</h1>
                    <p style="color: #333; font-size: 16px;">Hello <strong>${displayName}</strong>,</p>
                    <p style="color: #666;">Here is your verification code to complete your 2fa activation:</p>
                    
                    <div style="background-color: #f9f9f9; padding: 20px; border-radius: 6px; margin: 25px 0; text-align: center; border: 2px dashed #FF7B22;">
                        <p style="color: #999; font-size: 14px; margin: 0 0 10px 0;">Your verification code</p>
                        <p style="color: #FF7B22; font-size: 32px; font-weight: bold; letter-spacing: 8px; margin: 0; font-family: 'Courier New', monospace;">${VERIFICATION_CODE}</p>
                    </div>

                    <p style="color: #666;">This code will expire in <strong>5 minutes</strong>.</p>
                    <p style="color: #666;">If you did not attempt to log in, please ignore this email or contact support if you have concerns.</p>
                    
                    <p style="color: #999; font-size: 14px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee;">
                        This is an automated message from AlertUp. Please do not reply to this email.
                    </p>
                    </div>
                </div>
            `;

            await sendMail(req.user.email, "2FA Activation - AlertUp", twoFAText, undefined, twoFAHTML);
        }catch{
            console.error("2FA EMAIL ERROR.")
            return res.send({Success:false,Message:"Couldn't sent email."})
        }

        return res.send({Success:true,Message:"Sent."})
    }catch{
        console.log("Server error caught.")
        return res.send({Success:false,Message:'Server error.'})
    }
})

router.post('/api/2fa/deactivate',whoami,async(req,res)=>{
    try{
        const FIND_VERIFICATION = await VERIFICATIONS.findOne({verificationBy:req.user._id,verificationType:'2fa-deactivation'})
        if(FIND_VERIFICATION) {
            await VERIFICATIONS.findOneAndDelete({verificationBy:req.user._id,verificationType:'2fa-deactivation'})
        }

        const VERIFICATION_CODE = Math.floor(Math.random()*(999999-100000)+100000);
        const HASHEDCODE = await bcrypt.hash(String(VERIFICATION_CODE),12)
        const VERIFICATION_CONFIG ={
            verificationBy:req.user._id,
            verificationCode:HASHEDCODE,
            verificationType:'2fa-deactivation'
        }

        await VERIFICATIONS.create(VERIFICATION_CONFIG)

        try{
            const displayName = req.user.userType === "Individual" ? req.user.name : req.user.company;

            const twoFAText = `Hey ${displayName}, your two-factor authentication code is: ${VERIFICATION_CODE}. This code will expire in 5 minutes.`;

            const twoFAHTML = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
                    <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                    <h1 style="color: #FF7B22; margin-top: 0;">🔐 Two-Factor Deactivation</h1>
                    <p style="color: #333; font-size: 16px;">Hello <strong>${displayName}</strong>,</p>
                    <p style="color: #666;">Here is your verification code to deactivate 2fa:</p>
                    
                    <div style="background-color: #f9f9f9; padding: 20px; border-radius: 6px; margin: 25px 0; text-align: center; border: 2px dashed #FF7B22;">
                        <p style="color: #999; font-size: 14px; margin: 0 0 10px 0;">Your verification code</p>
                        <p style="color: #FF7B22; font-size: 32px; font-weight: bold; letter-spacing: 8px; margin: 0; font-family: 'Courier New', monospace;">${VERIFICATION_CODE}</p>
                    </div>

                    <p style="color: #666;">This code will expire in <strong>5 minutes</strong>.</p>
                    <p style="color: #666;">If you did not attempt to log in, please ignore this email or contact support if you have concerns.</p>
                    
                    <p style="color: #999; font-size: 14px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee;">
                        This is an automated message from AlertUp. Please do not reply to this email.
                    </p>
                    </div>
                </div>
            `;

            await sendMail(req.user.email, "2FA Deactivation - AlertUp", twoFAText, undefined, twoFAHTML);
        }catch{
            console.error("2fa verification deactivation  ERROR !")
            return res.send({Success:false,Message:"Couldn't sent email."})
        }

        return res.send({Success:true,Message:"Verification code sent."})
    }catch{
        console.error("2FA DEACTIVATION CAUGHT ERROR.")
        return res.send({Success:false,Message:"Server error."})
    }
})

router.post('/api/2fa/verify',whoami,async(req,res)=>{
    const {verificationCode,verificationType} = req.body;

    if(!verificationCode || verificationCode.length !== 6) return res.send({Success:false,Message:"Invalid verification code."});

    try{
        let VERIFICATION;

        if(verificationType == "activate") VERIFICATION = await VERIFICATIONS.findOne({verificationBy:req.user._id,verificationType:'2fa-activation'});
        if(verificationType == "deactivate") VERIFICATION = await VERIFICATIONS.findOne({verificationBy:req.user._id,verificationType:'2fa-deactivation'});

        if(!VERIFICATION) return res.send({Success:false,Message:"Invalid verification."})
        if(VERIFICATION.expires < Date.now()) return res.send({Success:false,Message:"Verification expired."})
        
        const compareCode = await bcrypt.compare(String(verificationCode),VERIFICATION.verificationCode)
        if(!compareCode) return res.send({Success:false,Message:"Invalid Code."})

        if(verificationType == "deactivate") await USERS.findOneAndUpdate({_id:req.user._id},{TwoFactorEnabled:false},{new:true})
        if(verificationType == "activate") await USERS.findOneAndUpdate({_id:req.user._id},{TwoFactorEnabled:true},{new:true})
        
        await VERIFICATIONS.findOneAndDelete({verificationBy:req.user._id})

        return res.send({Success:true,Message:"Done."})
    }catch{
        console.log("Something went wrong.")
        return res.send({Success:false,Message:'Server error.'})
    }
})

export default router;