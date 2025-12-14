import express from 'express';
const router = express.Router();

import USERS from '../../models/user.model';
import VERIFICATIONS from '../../models/verificatios.model';
import whoami from '../../middlewares/whoami'
import { Filter } from 'bad-words';
import bcrypt, { compare } from 'bcrypt'
import sendMail from '../../services/sendEmail'

const checkUsername = async(username,currentUsername) => {
    if (!username) {
        return "Invalid username.";
    }

    if (username.length < 4 || username.length > 24) {
        return "Username must be from 4 to 24 characters.";
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        return "Username contains invalid symbols.";
    }

    const filter= new Filter()

    if(filter.isProfane(username)){
        return "Username name contains forbidden words."
    }

    const findUsername = await USERS.findOne({username:username})
    if(findUsername && findUsername.username !== currentUsername){
        return "Username already exists."
    }

    return null;
};

router.put('/api/settings/save',whoami,async(req,res)=>{
    const {username,country,phone,countryCode} = req.body;

    try{
        const checkUser = await checkUsername(username);
        if(checkUser !== null){
            return res.send({Success:false,Message:checkUser})
        }

        if(!country || !phone || !countryCode){
            return res.send({Success:false,Message:"Invalid fields."})
        }

        await USERS.findOneAndUpdate(
            {
                _id:req.user._id
            },
            {
                username:username,
                country:country,
                countryCode:countryCode,
                phones:phone
            },
            {
                new:true
            }
        )

        return res.send({Success:true,Message:"saved."})
    }catch{
        return res.send({Success:false,Message:"Server error."})
    }
})

router.put('/api/settings/change-password',whoami,async(req,res)=>{
    const {oldPassword, newPassword} = req.body;
    const userData = req.user;

    try{

        const USER = await USERS.findById(userData._id)

        if(!oldPassword||!newPassword){
            return res.send({Success:false,Message:"Invalid fields."})
        }

        if( newPassword.length < 6 || newPassword.length > 16 ){
            return res.send({Success:false,Message:"Invalid password."})
        }

        if(oldPassword == newPassword){
            return res.send({Success:false,Message:"You can not use same password."})
        }

        const compare = await bcrypt.compare(USER.password,newPassword);

        if(compare){
            return res.send({Success:false,Message:"You can not use same password."})
        }
        const hashed = await bcrypt.hash(newPassword,10)
        await USERS.findOneAndUpdate({_id:USER._id},{password:hashed},{new:true});

        await sendMail(USER.email,'Password Changed - AlertUp',`Hello again ${USER.username}. You successfully changed your password. wasn't you? contact us right away.`);
        return res.send({Success:false,Message:"Saved."})
    }catch{
        return res.send({Success:false,Message:"Server error."})
    }
})

router.post('/api/settings/email',whoami,async(req,res)=>{
    const {newEmail}=req.body;
    const userData = req.user;

    try{
        if(!newEmail||!newEmail.includes('@')){
            return res.send({Success:false,Message:"Invalid email."})
        }

        const USER = await USERS.findById(userData._id);

        //check if already sent.
        if(await VERIFICATIONS.findOne({verificationBy:USER._id})){
            await VERIFICATIONS.findOneAndDelete({verificationBy:USER._id})
        }

        if(USER.email === newEmail){
            return res.send({Success:false,Message:"Can't use same email."})
        }

        const CODE = Math.floor(Math.random() * (999999-100000) - 100000);

        const VERIFICATIONCONFIG = {
            verificationType: 'change email',
            verificationCode: CODE,
            verificationBy: USER._id
        }

        const newVerification = await VERIFICATIONS(VERIFICATIONCONFIG);

        await sendMail(newEmail,"Verify new email - AlertUp",`Hello again ${USER.username} it's good to see you. Your new email verification code is here: ${CODE}. wasn't sent by you? contact us & don't share this code to anyone for your safety.`)

        await newVerification.save()

        return res.send({Success:true,Message:"Sent."})
    }catch{
        return res.send({Success:false,Message:"Server error."})
    }
})

router.put('/api/settings/email',whoami,async(req,res)=>{
    const {newEmail,userCode} = req.body;

    try{
        if(!newEmail || !userCode || !newEmail.includes('@') || userCode < 6 || userCode >6){
            return res.send({Success:false,Message:"Invalid fields."})
        }

        const USER = await USERS.findById(req.user._id);

        if(!USER){
            return res.send({Success:false,Message:"Invalid user."})
        }

        const getVerification = await VERIFICATIONS.findOne({verificationBy:USER._id});

        if(!getVerification){
            return res.send({Success:false,Message:"Expired or invalid token."})
        }

        if(getVerification.expires < Date.now()){
            return res.send({Success:false,Message:"Expired."})
        }

        if(getVerification.verificationCode !== userCode){
            return res.send({Success:false,Message:"Invalid Code."})
        }

        await USERS.findOneAndUpdate({_id:USER._id},{email:newEmail},{new:true})
        await sendMail(newEmail,'New email? - AlertUp',`Hey there ${USER.username}. Got a new email right? wasn't changed by you? contact us.`)

        return res.send({Success:true,Message:"Saved."})
        
    }catch{
        return res.send({Success:false,Message:"Server error."})
    }
})

router.post('/api/settings/verify',whoami,async(req,res)=>{
    
    try{
        const USER = await USERS.findById(req.user._id);

        if(!USER){
            return res.send({Success:false,Message:'Something went wrong.'})
        }
    
        if(await VERIFICATIONS.findOne({verificationBy:USER._id})){
            await VERIFICATIONS.findOneAndDelete({verificationBy:USER._id})
        }

        const CODE = Math.floor(Math.random()*(999999-100000)+100000);

        const VERIFICATION_CONFIG = {
            verificationBy:USER._id,
            verificationCode:CODE,
            verificationType:'Verify email'
        }

        const newVerification = await VERIFICATIONS(VERIFICATION_CONFIG);

        await sendMail(USER.email,'Verify Account - AlertUp',`Hello again ${USER.username} it's good to see you. here is your account verification code: ${CODE}.`)
        
        await newVerification.save()

        return res.send({Success:false,Message:"Sent."})
    }catch{
        return res.send({Success:false,Message:"Server error."})
    }
})

router.put('/api/settings/verify',whoami,async(req,res)=>{
    const {userCode} = req.body;

    if(!userCode || userCode.length <6 || userCode.length > 6){
        return res.send({Success:false,Message:"Invalid verification code."})
    }

    try{

        const USER = await USERS.findById(req.user._id);

        if(!USER){
            return res.send({Success:false,Message:"Something went wrong."})
        }

        const findVerification = await VERIFICATIONS.findOne({verificationBy:USER._id});

        if(!findVerification){
            return res.send({Success:false,Message:"Expired or invalid verification."})
        }

        if(findVerification.expires<new Date.now()){
            await VERIFICATIONS.findOneAndDelete({verificationBy:USER._id})
            return res.send({Success:false,Message:"Expired verification."})
        }

        if(findVerification.verificationCode !== userCode){
            return res.send({Success:false,Message:'Invalid code.'})
        }

        await VERIFICATIONS.findOneAndDelete({verificationBy:USER._id})

        await USERS.findOneAndUpdate({_id:USER._id},{verified:true},{new:true});
        await sendMail(USER.email,"Verified - AlertUp",`Hello ${USER.username} and congrats your account has been verified. Thank you for using AlertUp.`)

        return res.send({Success:true,Message:"Verified."})

    }catch{
        return res.send({Success:false,Message:"Server error."})
    }
})

router.delete('/api/settings/account',whoami,async(req,res)=>{
    const {password} = req.body;

    if(!password){
        return res.send({Success:false,Message:"Invalid password."})
    }

    try{
        const USER = await USERS.findById(req.user._id);

        if(!USER){
            return res.send({Success:false,Message:"Something went wrong."})
        }

        const comparePassword = await bcrypt.compare(password,USER.password)

        if(!comparePassword){
            return res.send({Success:false,Message:"Invalid password."})
        }

        await USERS.findOneAndDelete({_id:USER._id});
        res.clearCookie('userToken');

        await sendMail(USER.email,'Goodbye - AlertUp',`Hey ${USER.username}. it's our last email together. thanks for using alertup we hope you'll come back soon. goodbye.`)

        return res.send({Success:true,Message:"Deleted."})
    }catch{
        return res.send({Success:false,Message:"Server error."})
    }
})

router.post('/api/settings/logout',whoami,async(req,res)=>{
    const {password} = req.body;

    try{
        const USER = await USERS.findById(req.user._id);

        if(!USER){
            return res.send({Success:false,Message:"Something went wrong."})
        }

        const comparePassword = await bcrypt.compare(password,USER.password)

        if(!comparePassword){
            return res.send({Success:false,Message:"Invalid password."})
        }

        res.clearCookie('userToken');

        return res.send({Success:true,Message:"Logged out."})
    }catch{
        return res.send({Success:false,Message:"Server error."})
    }
})

export default router