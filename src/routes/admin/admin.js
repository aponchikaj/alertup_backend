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
import { authLimiter } from '../../services/rateLimiter.js';
import { displayName } from '../../services/displayName.js';
import { deleteUserCascade } from '../../services/cascadeDelete.js';
import { escapeHtml } from '../../services/escapeHtml.js';

/** Escape regex metacharacters in admin search input. */
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Normalize a search query: `?q=a&q=b` arrives as an array, which the driver
 * rejects, and unescaped metacharacters let a pattern like `(a+)+$` pin a CPU
 * on the database through catastrophic backtracking.
 */
const searchPattern = (q) => {
  const raw = Array.isArray(q) ? q[0] : q;
  return escapeRegex(String(raw ?? '').slice(0, 100));
};

const router = express.Router();

const PREMIUM_OPTIONS = {
  Basic: { title: "Basic", limits: { maxBuildings: 3, maxFloors: 5 }, price: 4.99, onSale: false, salePrice: 0 },
  Platinum: { title: "Platinum", limits: { maxBuildings: 6, maxFloors: 10 }, price: 9.99, onSale: false, salePrice: 0 },
  Elite: { title: "Elite", limits: { maxBuildings: 10, maxFloors: 20 }, price: 19.99, onSale: false, salePrice: 0 },
  Professional: { title: "Professional", limits: { maxBuildings: 25, maxFloors: 50 }, price: 29.99, onSale: false, salePrice: 0 }
};

// ########################################### IF ADMIN? SECTION ###########################################

// Reaching this handler means isAdmin verified the token — it returns 401/403 otherwise.
router.get('/api/admin/isAdmin', isAdmin, async (req, res) => {
  return res.send({ Success: true })
})

// ########################################### LOGIN SECTION ###########################################

router.post('/api/admin/login', authLimiter, async (req, res) => {
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

        const findUser = await USERS.findOne({ email: String(user).toLowerCase().trim() });

        if(!findUser){
            return res.status(404).send({Success:false,Message:"User not found."})
        }

        // This route previously returned "Sent." without ever calling sendMail,
        // so admins were told their message had been delivered and the
        // recipient never received anything.
        const adminMessageHTML = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
            <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
              <h1 style="color: #FF7B22; margin-top: 0;">${escapeHtml(subject)}</h1>
              <p style="color: #333; font-size: 16px;">Hello <strong>${escapeHtml(displayName(findUser))}</strong>,</p>
              <p style="color: #666; white-space: pre-wrap;">${escapeHtml(text)}</p>
              <p style="color: #666; font-size: 14px; margin-top: 20px;">Best regards,<br><strong style="color: #FF7B22;">AlertUp Team</strong></p>
            </div>
          </div>
        `;

        try {
          await sendMail(findUser.email, String(subject), String(text), undefined, adminMessageHTML)
        } catch (err) {
          console.error("MAIL ERROR:", err);
          return res.status(502).send({Success:false,Message:"Couldn't send the email."})
        }

        return res.send({Success:true,Message:"Sent."})

    }catch(err){
        console.error('Admin sendMail error:', err)
        return res.status(500).send({Success:false,Message:"Server error."})
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

    const safeQ = searchPattern(q);
    const searchQuery = q
      ? {
          $or: [
            { name: { $regex: safeQ, $options: 'i' } },
            { lastname: { $regex: safeQ, $options: 'i' } },
            { company: { $regex: safeQ, $options: 'i' } },
            { email: { $regex: safeQ, $options: 'i' } }
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

    const safeQ = searchPattern(q);
    const searchQuery = {
      'premium.hasPremium': true,
      ...(q && {
        $or: [
          { name: { $regex: safeQ, $options: 'i' } },
          { lastname: { $regex: safeQ, $options: 'i' } },
          { company: { $regex: safeQ, $options: 'i' } },
          { email: { $regex: safeQ, $options: 'i' } }
        ]
      })
    };

    const users = await USERS.find(searchQuery)
      .select('-password')
      .skip((page - 1) * limit)
      .limit(limit)
      // premium.startedAt does not exist on the schema — the field written by
      // givePremium is premium.from. Sorting on a missing path left pagination
      // unstable, so the same user could appear on two pages.
      .sort({ 'premium.from': -1 })
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
  try {
    if (!userID || !mongoose.Types.ObjectId.isValid(userID)) {
      return res.status(400).send({ Success: false, Message: "Invalid user ID" });
    }

    // The password is select:false on the schema now, but this route also
    // returned trustedIPS and transactions to the browser. It was the only
    // user-detail route that forgot to narrow the projection.
    const user = await USERS.findById(userID).select('-trustedIPS -transactions')

    if (!user) {
      return res.status(404).send({ Success: false, Message: "User not found." });
    }

    return res.send({ Success: true, Message: user });

  } catch (err) {
    console.error(err)
    return res.status(500).send({ Success: false, Message: 'Server error !!!' });
  }
});

router.delete('/api/admin/user/:id',isAdmin,async(req,res)=>{
    const userID = req.params.id
    const {reason} = req.body
    try{
        if(!userID || !mongoose.Types.ObjectId.isValid(userID)){
            return res.status(400).send({Success:false,Message:"Invalid user ID"})
        }

        const user = await USERS.findById(userID)

        if(!user){
            return res.status(404).send({Success:false,Message:"User not found."})
        }

        // Removes their buildings, floors, nodes, logs and reviews too. Deleting
        // only the user document left all of that orphaned and unreachable,
        // while the email below stated it had been removed.
        await deleteUserCascade(user._id)

        // Was Success:false on the success path, so the admin UI reported a
        // failure and kept showing a user that had in fact been deleted.
        res.send({Success:true,Message:"Deleted."})
        try {
          const adminDeleteHTML = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
              <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                <h1 style="color: #d32f2f; margin-top: 0;">⚠️ Account Deletion Notice</h1>
                <p style="color: #333; font-size: 16px;">Hello Dear <strong>${displayName(user)}</strong>,</p>
                <p style="color: #666;">We've decided that your account should be deleted.</p>
                <div style="background-color: #ffebee; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #f44336;">
                  <p style="margin: 0; color: #c62828; font-weight: bold;">Reason for Deletion</p>
                  <p style="margin: 5px 0 0 0; color: #666; font-size: 14px;">${escapeHtml(reason)}</p>
                </div>
                <p style="color: #666; font-size: 14px;">All your data has been permanently removed from our system.</p>
                <p style="color: #666; font-size: 14px; margin-top: 20px;">We are sorry to see you go. If you have any questions, please contact our support team.</p>
                <p style="color: #666; font-size: 14px; margin-top: 20px;">Best regards,<br><strong style="color: #FF7B22;">AlertUp Team</strong></p>
              </div>
            </div>
          `;
          await sendMail(user.email,'Account deleted - AlertUp',`Hello Dear ${displayName(user)} we've decided that your account should be deleted. reason:${reason}. we are sorry goodbye.`, undefined, adminDeleteHTML)
        } catch (err) {
          console.error("MAIL ERROR:", err);
        }
    }catch{
        return res.send({Success:false,Message:"Server error."})
    }
})

router.put('/api/admin/user/:id', isAdmin, async (req, res) => {
  const userID = req.params.id;
  const { name, lastname, company, country, countryCode, phoneNumber, verified } = req.body;

  try {
    if (!userID) {
      return res.send({ Success: false, Message: "Invalid user ID." });
    }

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (lastname !== undefined) updates.lastname = lastname;
    if (company !== undefined) updates.company = company;
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

    // `till` went into the update unvalidated: a malformed value produced a
    // CastError reported only as "Server error.", and a date in the past
    // silently granted a plan that whoami revokes on the user's next request.
    const expiresAt = new Date(till);
    if (isNaN(expiresAt.getTime())) {
      return res.status(400).send({ Success: false, Message: "Invalid expiry date." });
    }
    if (expiresAt <= today) {
      return res.status(400).send({ Success: false, Message: "Expiry date must be in the future." });
    }

    const user = await USERS.findByIdAndUpdate(
      userID,
      {
        'premium.hasPremium': true,
        'premium.premiumType': premiumOption,
        'premium.from': today,
        'premium.to': expiresAt
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

        const safeQ = searchPattern(q);
        const searchQuery = q
        ? {
            $or: [
                { buildingName: { $regex: safeQ, $options: 'i' } },
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
    }catch(err){
        // Was Success:true, so on a DB error the client took the success branch
        // and read Message.buildings off a string, crashing the admin page.
        console.error('Admin buildings list error:', err)
        return res.status(500).send({Success:false,Message:"Server error."})
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
        // Was Success:true on the rejection path, so the admin UI treated an
        // invalid id as a successful delete and removed the row optimistically.
        if(!reportID || !mongoose.Types.ObjectId.isValid(reportID)){
            return res.status(400).send({Success:false,Message:"Invalid report ID."})
        }

        // The stray .catch here swallowed the rejection and sent a response,
        // then execution fell through to the success reply below — a second
        // res.send that threw ERR_HTTP_HEADERS_SENT and destroyed the socket.
        const deleted = await REPORTS.findOneAndDelete({_id:reportID})
        if(!deleted){
            return res.status(404).send({Success:false,Message:"Report not found."})
        }

        return res.send({Success:true,Message:"Deleted."})
    }catch(err){
        console.error('Admin report delete error:', err)
        return res.status(500).send({Success:false,Message:'Server error.'})
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
        if(!contactID || !mongoose.Types.ObjectId.isValid(contactID)){
            return res.status(400).send({Success:false,Message:"Invalid contact ID."})
        }

        // Same double-response bug as the report delete above.
        const deleted = await CONTACTS.findOneAndDelete({_id:contactID})
        if(!deleted){
            return res.status(404).send({Success:false,Message:"Contact not found."})
        }

        return res.send({Success:true,Message:"Deleted."})
    }catch(err){
        console.error('Admin contact delete error:', err)
        return res.status(500).send({Success:false,Message:'Server error.'})
    }
})

export default router
