import express from 'express';
import mongoose from 'mongoose';
import USERS from '../../models/user.model.js';
import BUILDINGS from '../../models/building.model.js';
import CONTACTS from '../../models/contact.model.js';
import REPORTS from '../../models/report.model.js';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken'
dotenv.config()

import isAdmin from '../../middlewares/isAdmin.js';
import sendMail from '../../services/sendEmail.js';

const router = express.Router();

const PREMIUM_OPTIONS = {
  Basic: { title: "Basic", limits: { maxBuildings: 3, maxFloors: 5 }, price: 4.99, onSale: false, salePrice: 0 },
  Platinum: { title: "Platinum", limits: { maxBuildings: 6, maxFloors: 10 }, price: 9.99, onSale: false, salePrice: 0 },
  Elite: { title: "Elite", limits: { maxBuildings: 10, maxFloors: 20 }, price: 19.99, onSale: false, salePrice: 0 },
  Professional: { title: "Professional", limits: { maxBuildings: 25, maxFloors: 50 }, price: 29.99, onSale: false, salePrice: 0 }
};

// ########################################### IF ADMIN? SECTION ###########################################

router.get('/api/admin/isAdmin',isAdmin,async(req,res)=>{
  try{
    if(req.isAdmin = false){
      return res.send({Success:false})
    }

    return res.send({Success:true})
  }catch{
    return res.send({Success:false,Message:"Something went wrong."})
  }
})

// ########################################### LOGIN SECTION ###########################################

router.post('/api/admin/login', async (req, res) => {
  const { user, password } = req.body;

  try {
    if (!user || !password) {
      return res.send({ Success: false, Message: 'Invalid credentials.' });
    }

    const ADMIN_USER = process.env.ADMIN_USER;
    const ADMIN_PASS = process.env.ADMIN_PASS;

    if (user !== ADMIN_USER || password !== ADMIN_PASS) {
      return res.send({ Success: false, Message: 'Invalid credentials.' });
    }

    const adminToken = jwt.sign(
      { isAdmin: true },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Determine whether the current request is secure (HTTPS)
    const reqIsSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';

    res.cookie('adminToken', adminToken, {
      httpOnly: true,
      secure: reqIsSecure,
      sameSite: reqIsSecure ? 'None' : 'Lax',
      maxAge: 60 * 60 * 1000,
      path: '/', // Ensure cookie is available across all paths
    });

    res.send({ Success: true, Message: 'Logged in.' });

    try {
        const adminLoginHTML = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
            <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
              <h1 style="color: #d32f2f; margin-top: 0;">🔐 Admin Login Alert</h1>
              <p style="color: #333; font-size: 16px;">Security Notification</p>
              <p style="color: #666;">Someone logged in as <strong>admin</strong> on AlertUp.</p>
              <div style="background-color: #ffebee; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #f44336;">
                <p style="margin: 0; color: #c62828; font-weight: bold;">⚠️ Login Details</p>
                <p style="margin: 5px 0; color: #666; font-size: 14px;"><strong>IP Address:</strong> ${req.ip}</p>
                <p style="margin: 5px 0 0 0; color: #666; font-size: 14px;"><strong>Device:</strong> ${req.headers['user-agent']}</p>
              </div>
              <p style="color: #666; font-size: 14px;">If this wasn't you, secure your account immediately.</p>
              <p style="color: #666; font-size: 14px; margin-top: 20px;">Best regards,<br><strong style="color: #FF7B22;">AlertUp Security Team</strong></p>
            </div>
          </div>
        `;
        await sendMail(
        process.env.GMAIL_USER,
        'New admin login – AlertUp',
        `Admin Login Alert: Someone logged in as admin on AlertUp. IP: ${req.ip}, Device: ${req.headers['user-agent']}. If this wasn't you, secure your account immediately.`,
        undefined,
        adminLoginHTML
      );
    } catch (err) {
        console.error("MAIL ERROR:", err);
    }

  } catch (err) {
    return res.send({ Success: false, Message: 'Server error.' });
  }
});

router.post('/api/admin/logout',async(req,res)=>{
  try{
    // if(req.isAdmin == false){
    //   return {Success:false,Message:"Something went wrong."}
    // }
    // Determine whether the current request is secure (HTTPS)
    const reqIsSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    
    res.clearCookie('adminToken', {
      httpOnly: true,
      secure: reqIsSecure,
      sameSite: reqIsSecure ? 'None' : 'Lax',
      path: '/',
    });
    return res.send({Success:true,Message:"Logged out."})
  }catch{
    return res.send({Success:false,Message:"Something went wrong."})
  }
})

// ########################################### SendMail SECTION ###########################################

router.post('/api/admin/sendMail',isAdmin,async(req,res)=>{
    const {user,subject,text} = req.body;

    try{
        if(!user || !subject || !text){
            return res.send({Success:false,Message:'Invalid fields.'})
        }

        const findUser =await USERS.findOne({username:user});

        if(!findUser){
            return res.send({Success:false,Message:"User not found."})
        }

        try {
          return res.send({Success:true,Message:"Sent."})
        } catch (err) {
            console.error("MAIL ERROR:", err);
        }

        return res.send({Success:true,Message:"Sent."})

    }catch{
        return res.send({Success:false,Message:"Server error."})
    }
})

// ########################################### DASHBOARD SECTION ###########################################

router.get( '/api/admin/dashboard', isAdmin, async ( req, res )=>{
    try{    
        const PREMIUM_USERS_COUNT = await USERS.countDocuments({
            'premium.hasPremium': true
        });
        const USERS_COUNT = await USERS.countDocuments();
        const REPORTS_COUNT = await REPORTS.countDocuments();
        const BUILDINGS_COUNT = await BUILDINGS.countDocuments();

        return res.send({Success:true,Message:{
            USERS_COUNT,PREMIUM_USERS_COUNT,REPORTS_COUNT,BUILDINGS_COUNT
        }})
        
    }catch{
        return res.send({Success:false,Message:"Server error."})
    }
})

// ########################################### USERS SECTION ###########################################

router.get('/api/admin/users', isAdmin, async (req, res) => {
  try {
    let { q = '', page = 1, limit = 20 } = req.query;

    page = Math.max(parseInt(page) || 1, 1);
    limit = Math.min(parseInt(limit) || 20, 100);

    const searchQuery = q
      ? {
          $or: [
            { username: { $regex: q, $options: 'i' } },
            { email: { $regex: q, $options: 'i' } }
          ]
        }
      : {};

    const users = await USERS.find(searchQuery)
      .select('-password')
      .skip((page - 1) * limit)
      .limit(limit)
      .sort({ createdAt: -1 })
      .lean();

    const total = await USERS.countDocuments(searchQuery);

    return res.send({
      Success: true,
      Message: {
        users,
        page,
        totalPages: Math.ceil(total / limit),
        totalUsers: total
      }
    });

  } catch (err) {
    return res.send({ Success: false, Message: 'Server error' });
  }
});

router.get('/api/admin/premiumUsers', isAdmin, async (req, res) => {
  try {
    let { q = '', page = 1, limit = 20 } = req.query;

    page = Math.max(parseInt(page) || 1, 1);
    limit = Math.min(parseInt(limit) || 20, 100);

    const searchQuery = {
      'premium.hasPremium': true,
      ...(q && {
        $or: [
          { username: { $regex: q, $options: 'i' } },
          { email: { $regex: q, $options: 'i' } }
        ]
      })
    };

    const users = await USERS.find(searchQuery)
      .select('-password')
      .skip((page - 1) * limit)
      .limit(limit)
      .sort({ 'premium.startedAt': -1 })
      .lean();

    const total = await USERS.countDocuments(searchQuery);

    return res.send({
      Success: true,
      Message: {
        users,
        page,
        totalPages: Math.ceil(total / limit),
        totalPremiumUsers: total
      }
    });

  } catch (err) {
    return res.send({
      Success: false,
      Message: 'Server error'
    });
  }
});

router.get('/api/admin/user/:id', isAdmin, async (req, res) => {
  const userID = req.params.id;
  console.log(userID)
  try {
    if (!userID) {
      return res.send({ Success: false, Message: "Invalid user ID" });
    }

    const user = await USERS.findOne({_id:userID.toString('hex')})

    if (!user) {
      return res.send({ Success: false, Message: "User not found." });
    }

    return res.send({ Success: true, Message: user });

  } catch (err) {
    console.error(err)
    return res.send({ Success: false, Message: 'Server error !!!' });
  }
});

router.delete('/api/admin/user/:id',isAdmin,async(req,res)=>{
    const userID = req.params.id
    const {reason} = req.body
    try{
        if(!userID){
            return res.send({Success:false,Message:"Invalid user ID"})
        }

        const user = await USERS.findById(userID)

        if(!user){
            return res.send({Success:false,Message:"User not found."})
        }
    
        await USERS.findOneAndDelete({_id:user._id})

        res.send({Success:false,Message:"Deleted."})
        try {
          const adminDeleteHTML = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
              <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                <h1 style="color: #d32f2f; margin-top: 0;">⚠️ Account Deletion Notice</h1>
                <p style="color: #333; font-size: 16px;">Hello Dear <strong>${user.username}</strong>,</p>
                <p style="color: #666;">We've decided that your account should be deleted.</p>
                <div style="background-color: #ffebee; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #f44336;">
                  <p style="margin: 0; color: #c62828; font-weight: bold;">Reason for Deletion</p>
                  <p style="margin: 5px 0 0 0; color: #666; font-size: 14px;">${reason}</p>
                </div>
                <p style="color: #666; font-size: 14px;">All your data has been permanently removed from our system.</p>
                <p style="color: #666; font-size: 14px; margin-top: 20px;">We are sorry to see you go. If you have any questions, please contact our support team.</p>
                <p style="color: #666; font-size: 14px; margin-top: 20px;">Best regards,<br><strong style="color: #FF7B22;">AlertUp Team</strong></p>
              </div>
            </div>
          `;
          await sendMail(user.email,'Account deleted - AlertUp',`Hello Dear ${user.username} we've decided that your account should be deleted. reason:${reason}. we are sorry goodbye.`, undefined, adminDeleteHTML)
        } catch (err) {
          console.error("MAIL ERROR:", err);
        }
    }catch{
        return res.send({Success:false,Message:"Server error."})
    }
})

router.put('/api/admin/user/:id', isAdmin, async (req, res) => {
  const userID = req.params.id;
  const { username, country, countryCode, phoneNumber, verified } = req.body;

  try {
    if (!userID) {
      return res.send({ Success: false, Message: "Invalid user ID." });
    }

    const updates = {};
    if (username !== undefined) updates.username = username;
    if (country !== undefined) updates.country = country;
    if (countryCode !== undefined) updates.countryCode = countryCode;
    if (phoneNumber !== undefined) updates.phones = phoneNumber;
    if (verified !== undefined) updates.verified = verified;

    const user = await USERS.findByIdAndUpdate(
      userID,
      updates,
      { new: true }
    );

    if (!user) {
      return res.send({ Success: false, Message: "User not found." });
    }

    return res.send({ Success: true, Message: "Updated." });

  } catch {
    return res.send({ Success: false, Message: "Server error." });
  }
});

router.post('/api/admin/user/givePremium/:id', isAdmin, async (req, res) => {
  const userID = req.params.id;
  const { premiumOption, till } = req.body;

  try {
    if (!userID) {
      return res.send({ Success: false, Message: "Invalid user ID." });
    }

    const allowedPlans = [
      PREMIUM_OPTIONS.Basic.title,
      PREMIUM_OPTIONS.Elite.title,
      PREMIUM_OPTIONS.Platinum.title,
      PREMIUM_OPTIONS.Professional.title
    ];

    if (!allowedPlans.includes(premiumOption)) {
      return res.send({ Success: false, Message: "Invalid Premium option." });
    }

    const today = new Date();

    const user = await USERS.findByIdAndUpdate(
      userID,
      {
        'premium.hasPremium': true,
        'premium.premiumType': premiumOption,
        'premium.from': today,
        'premium.to': till
      },
      { new: true }
    );

    if (!user) {
      return res.send({ Success: false, Message: "User not found." });
    }

    return res.send({ Success: true, Message: "Saved." });

  } catch {
    return res.send({ Success: false, Message: "Server error." });
  }
});

// ########################################### BUILDINGS SECTION ###########################################

router.get('/api/admin/buildings',isAdmin,async(req,res)=>{
    try{
        let { q = '', page = 1, limit = 20 } = req.query;

        page = Math.max(parseInt(page) || 1, 1);
        limit = Math.min(parseInt(limit) || 20, 100);

        const searchQuery = q
        ? {
            $or: [
                { buildingName: { $regex: q, $options: 'i' } },
            ]
            }
        : {};

        const buildings = await BUILDINGS.find(searchQuery)
        .skip((page - 1) * limit)
        .limit(limit)
        .sort({ createdAt: -1 })
        .lean();

        const total = await BUILDINGS.countDocuments(searchQuery);

        return res.send({
        Success: true,
        Message: {
            buildings,
            page,
            totalPages: Math.ceil(total / limit),
            totalUsers: total
        }
        });
    }catch{
        return res.send({Success:true,Message:"Server error."})
    }
}) 

router.get('/api/admin/buildings/:id',isAdmin,async(req,res)=>{
    const buildingID = req.params.id;

    try{
        if(!buildingID){
            return res.send({Success:false,Message:"Invalid building id."})
        }

        const findBuilding = await BUILDINGS.findById(buildingID)
        
        if(!findBuilding){
            return res.send({Success:false,Message:"Building not found."})
        }

        return res.send({Success:true,Message:findBuilding})

    }catch{
        return res.send({Success:false,Message:"Servere error."})
    }
})

router.delete('/api/admin/buildings/:id',isAdmin,async(req,res)=>{
    const buildingID = req.params.id;

    try{
        if(!buildingID || !mongoose.Types.ObjectId.isValid(buildingID)){
            return res.send({Success:false,Message:"Invalid building id."})
        }

        const findBuilding = await BUILDINGS.findById(buildingID)
        
        if(!findBuilding){
            return res.send({Success:false,Message:"Building not found."})
        }

        // Delete the building
        await BUILDINGS.findByIdAndDelete(findBuilding._id);

        // Remove from owner's Buildings array
        await USERS.findByIdAndUpdate(
            findBuilding.owner,
            { $pull: { Buildings: findBuilding._id } },
            { new: true }
        );

        return res.send({Success:true,Message:"Deleted."})
    }catch(err){
        console.error('Admin delete building error:', err);
        return res.send({Success:false,Message:'Server error.'})
    }
})

// ########################################### REPORTS SECTION ###########################################

router.get('/api/admin/reports',isAdmin,async(req,res)=>{
    try{
        const reports = await REPORTS.find()

        return res.send({Success:true,Message:reports})
    }catch{
        return res.send({Success:false,Message:'Server error.'})
    }
})

router.delete('/api/admin/reports/:id',isAdmin,async(req,res)=>{
    const reportID = req.params.id;

    try{
        if(!reportID){
            return res.send({Success:true,Message:"invalid Report ID."})
        }

        await REPORTS.findOneAndDelete({_id:reportID}).catch(()=>{return res.send({Success:false,Message:"Couldn't delete report."})})

        return res.send({Success:true,Message:"Deleted."})
    }catch{
        return res.send({Success:false,Message:'Server error.'})
    }
})

// ########################################### CONTACTS SECTION ###########################################

router.get('/api/admin/contacts',isAdmin,async(req,res)=>{
    try{
        const contacts = await CONTACTS.find()

        return res.send({Success:true,Message:contacts})
    }catch{
        return res.send({Success:false,Message:'Server error.'})
    }
})

router.delete('/api/admin/contacts/:id',isAdmin,async(req,res)=>{
    const contactID = req.params.id;

    try{
        if(!contactID){
            return res.send({Success:true,Message:"invalid Report ID."})
        }

        await CONTACTS.findOneAndDelete({_id:contactID}).catch(()=>{return res.send({Success:false,Message:"Couldn't delete report."})})

        return res.send({Success:true,Message:"Deleted."})
    }catch{
        return res.send({Success:false,Message:'Server error.'})
    }
})

export default router
