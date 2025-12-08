import express from 'express';
const router = express.Router();

import USERS from '../../models/user.model';
import whoami from '../../middlewares/whoami'
import bcrypt from 'bcrypt'
import sendMail from '../../services/sendEmail'

const checkUsername = async(username,currentUsername) => {
  if (!username) {
    return "Invalid username.";
  }

  if (username.length < 4 || username.length > 24) {
    return "Username must be from 4 to 24 characters.";
  }

  // allow only letters, numbers, underscore
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return "Username contains invalid symbols.";
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
                phone:phone
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

router.put('/api/settings/email/send',whoami,async(req,res)=>{
    const {}=req.body;
})

export default router