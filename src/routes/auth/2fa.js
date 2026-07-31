import express from "express";
import USERS from "../../models/user.model.js";
import VERIFICATIONS from '../../models/verificatios.model.js'
import sendMail from '../../services/sendEmail.js';
import whoami from '../../middlewares/whoami.js'
import bcrypt from 'bcrypt'
import { displayName } from '../../services/displayName.js'
import { emailLimiter, authLimiter } from '../../services/rateLimiter.js'
import crypto from 'crypto'

const router = express.Router()

// Math.random() is predictable from a few observed outputs; a verification code
// must come from a CSPRNG.
const generateCode = () => crypto.randomInt(100000, 1000000)

// Wrong guesses allowed against a single code before it is destroyed.
const MAX_CODE_ATTEMPTS = 5

router.post('/api/2fa/activate',whoami,emailLimiter,async(req,res)=>{
    // making new verification + code and sending it to users email and sending response
    try{
        const FIND_VERIFICATION = await VERIFICATIONS.findOne({verificationBy:req.user._id,verificationType:"2fa-activation"});
        if(FIND_VERIFICATION) {
            await VERIFICATIONS.findOneAndDelete({verificationBy:req.user._id,verificationType:"2fa-activation"})
        }

        const VERIFICATION_CODE = generateCode()
        const hashedCode = await bcrypt.hash(String(VERIFICATION_CODE),12)
        const VERIFICATION_CONFIG = {
            verificationBy:req.user._id,
            verificationCode:hashedCode,
            verificationType:"2fa-activation"
        }

        await VERIFICATIONS.create(VERIFICATION_CONFIG)

        try{
            const userName = displayName(req.user);

            const twoFAText = `Hey ${userName}, your two-factor authentication code is: ${VERIFICATION_CODE}. This code will expire in 5 minutes.`;

            const twoFAHTML = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
                    <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                    <h1 style="color: #FF7B22; margin-top: 0;">🔐 Two-Factor Authentication</h1>
                    <p style="color: #333; font-size: 16px;">Hello <strong>${userName}</strong>,</p>
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

router.post('/api/2fa/deactivate',whoami,emailLimiter,async(req,res)=>{
    try{
        const FIND_VERIFICATION = await VERIFICATIONS.findOne({verificationBy:req.user._id,verificationType:'2fa-deactivation'})
        if(FIND_VERIFICATION) {
            await VERIFICATIONS.findOneAndDelete({verificationBy:req.user._id,verificationType:'2fa-deactivation'})
        }

        const VERIFICATION_CODE = generateCode();
        const HASHEDCODE = await bcrypt.hash(String(VERIFICATION_CODE),12)
        const VERIFICATION_CONFIG ={
            verificationBy:req.user._id,
            verificationCode:HASHEDCODE,
            verificationType:'2fa-deactivation'
        }

        await VERIFICATIONS.create(VERIFICATION_CONFIG)

        try{
            const userName = displayName(req.user);

            const twoFAText = `Hey ${userName}, your two-factor authentication code is: ${VERIFICATION_CODE}. This code will expire in 5 minutes.`;

            const twoFAHTML = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
                    <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                    <h1 style="color: #FF7B22; margin-top: 0;">🔐 Two-Factor Deactivation</h1>
                    <p style="color: #333; font-size: 16px;">Hello <strong>${userName}</strong>,</p>
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

// authLimiter added: this endpoint checks a 6-digit code and can switch off the
// account's second factor, but was the only code-checking route with no
// throttle at all.
router.post('/api/2fa/verify',whoami,authLimiter,async(req,res)=>{
    const {verificationCode,verificationType} = req.body;

    if(!verificationCode) return res.status(400).send({Success:false,Message:"Invalid verification code."});
    if(verificationType !== "activate" && verificationType !== "deactivate"){
        return res.status(400).send({Success:false,Message:"Invalid verification type."})
    }

    const expectedType = verificationType === "activate" ? '2fa-activation' : '2fa-deactivation';

    try{
        const VERIFICATION = await VERIFICATIONS.findOne({verificationBy:req.user._id,verificationType:expectedType});

        if(!VERIFICATION) return res.status(400).send({Success:false,Message:"Invalid verification."})
        if(VERIFICATION.expires < Date.now()) {
            await VERIFICATIONS.findByIdAndDelete(VERIFICATION._id)
            return res.status(400).send({Success:false,Message:"Verification expired."})
        }

        const compareCode = await bcrypt.compare(String(verificationCode),VERIFICATION.verificationCode)
        if(!compareCode) {
            // Destroyed after repeated wrong guesses so the code cannot be
            // ground down to disable someone's second factor.
            VERIFICATION.attempts = (VERIFICATION.attempts || 0) + 1;
            if(VERIFICATION.attempts >= MAX_CODE_ATTEMPTS){
                await VERIFICATIONS.findByIdAndDelete(VERIFICATION._id)
                return res.status(400).send({Success:false,Message:"Too many incorrect attempts. Request a new code."})
            }
            await VERIFICATION.save()
            return res.status(400).send({Success:false,Message:"Invalid Code."})
        }

        if(verificationType == "deactivate") await USERS.findOneAndUpdate({_id:req.user._id},{TwoFactorEnabled:false})
        if(verificationType == "activate") {
            // trustedIPS is cleared on activation. Otherwise every address the
            // user had logged in from before enabling 2FA stayed on the skip
            // list, so an attacker who already knew the password and had logged
            // in once would never be challenged.
            await USERS.findOneAndUpdate({_id:req.user._id},{TwoFactorEnabled:true,trustedIPS:[]})
        }

        // Scoped to the consumed verification. An unscoped delete removed an
        // arbitrary record for this user — typically an in-flight password
        // reset — while leaving the just-used 2FA code replayable.
        await VERIFICATIONS.findByIdAndDelete(VERIFICATION._id)

        return res.send({Success:true,Message:"Done."})
    }catch(err){
        console.error("2FA verify error:", err)
        return res.status(500).send({Success:false,Message:'Server error.'})
    }
})

export default router;