import express from 'express'
const router = express.Router()

import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import {Filter} from 'bad-words'

import USERS from '../../models/user.model.js'
import sendMail from '../../services/sendEmail.js'

const checkUsername = async(username) => {
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

  const filter = new Filter()

  if(filter.isProfane(username)){
    return "Username contains forbidden words."
  }

  const findUsername = await USERS.findOne({username:username})
  if(findUsername){
    return "Username already exists."
  }

  return null;
};

const checkEmail = async(email)=>{
    if(!email){
        return "Invalid email."
    }

    if(email.length<1||email.length>355){
        return "Invalid email length."
    }

    if(!email.includes('@')){
        return "Invalid email."
    }

    const findEmail = await USERS.findOne({email:email})

    if(findEmail){
      return "email already exists."
    }

    return null;
}

const checkPassword = async(password)=>{
  if(!password){
    return "Invalid password."
  }

  if(password.length<6||password.length>16){
    return "Password must be from 6 to 16 characters."
  }

  return null;
}

router.post('/api/auth/register', async (req, res) => {
  try {
    const {
      username,
      email,
      password,
      country,
      countryCode,
      phone
    } = req.body;

    if (!username || !email || !password || !country || !countryCode) {
      return res.send({
        Success: false,
        Message: "Missing required fields."
      });
    }

    const usernameError = await checkUsername(username);
    if (usernameError !== null) {
      return res.send({ Success: false, Message: usernameError });
    }

    const emailError = await checkEmail(email)
    if(emailError !== null){
      return res.send({ Success:false, Message:emailError })
    }

    const passwordError = await checkPassword(password)
    if(passwordError !== null){
      return res.send({ Success:false, Message:passwordError })
    }

    const HashedPassword = await bcrypt.hash(password,10)

    const userConfig = {
      username,
      password:HashedPassword,
      email,
      phones:phone,
      country,
      countryCode,
      updatedAt:`${new Date().toISOString()}`
    }

    const NewUser = await USERS(userConfig);
    await NewUser.save()

    await sendMail(email,"Welcome - AlertUp",`Hello ${username} it's good to see you. please verify your email to create and modify your new building's map. Thank you !`)

    const userToken = await jwt.sign({userID:NewUser._id},process.env.JWT_SECRET,{
      expiresIn:'7d'
    })

    res.cookie('userToken', userToken, {
      httpOnly: true,           // safe: JS cannot read
      secure: false,            // true in production HTTPS, false for local dev / LAN IP
      sameSite: 'lax',          // 'none' if using cross-origin HTTPS, 'lax' works for SPA LAN
      maxAge: 7 * 24 * 60 * 60 * 1000
    }); 

    return res.send({Success:true,Message:"Registered."})

  } catch (err) {
    return res.status(500).send({
      Success: false,
      Message: "Server error."
    });
  }
});

router.post('/api/auth/login',async(req,res)=>{
  const {user,password}=req.body

  if(!user||!password){
    return res.send({Success:false,Message:"Invalid fields."})
  }

  try{
    let USER;

    if(user.includes('@')){
      USER = await USERS.findOne({email:user})
    }else if(!user.includes('@')){
      USER = await USERS.findOne({username:user});
    }

    if(!USER){
      return res.send({Success:false,Message:'Invalid credentials.'})
    }

    const checkPassword = await bcrypt.compare(password,USER.password);
    if(!checkPassword){
      return res.send({Success:false,Message:"Invalid credentials."})
    }

    await sendMail(USER.email,"New Login - AlertUp",`Hey someone has logged into your account. was that you? contact us if it wasn't you.`)

    const userToken = await jwt.sign({userID:USER._id},process.env.JWT_SECRET,{
      expiresIn:'7d'
    })

    res.cookie('userToken', userToken, {
      httpOnly: true,           // safe: JS cannot read
      secure: false,            // true in production HTTPS, false for local dev / LAN IP
      sameSite: 'lax',          // 'none' if using cross-origin HTTPS, 'lax' works for SPA LAN
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    return res.send({Success:true,Message:"Logged in."})
  }catch{
    return res.send({Success:false,Message:"Server error."})
  }
})

export default router