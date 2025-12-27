import jwt from 'jsonwebtoken'
import USERS from '../models/user.model.js'
import mongoose from 'mongoose'

const whoami = async(req,res,next)=>{
    // Check if database is connected
    if (mongoose.connection.readyState !== 1) {
        return res.status(503).send({Success:false,Message:"Database connection unavailable. Please try again later."})
    }

    // Try to get token from cookie first, then from Authorization header (Safari/iOS fallback)
    let userToken = req.cookies['userToken']
    
    // If no cookie, check Authorization header (for Safari/iOS localStorage fallback)
    if(!userToken){
        const authHeader = req.headers['authorization'];
        if(authHeader && authHeader.startsWith('Bearer ')){
            userToken = authHeader.substring(7); // Remove 'Bearer ' prefix
        }
    }

    if(!userToken){
        return res.send({Success:false,Message:"no user token."})
    }

    try{
        const data = jwt.verify(userToken,process.env.JWT_SECRET);
        if(!data){
            return res.send({Success:false,Message:"Invalid Token"})
        }

        const user = await USERS.findOne({_id:data.userID});
        if(!user){
            return res.send({Success:false,Message:'Invalid User ID.'})
        }

        if (
                user.premium?.hasPremium &&
                user.premium?.to &&
                new Date(user.premium.to) < new Date()
            ) {
                user.premium.hasPremium = false;
                user.premium.premiumType = null;
                user.premium.to = null;

            await user.save();
        }

        req.user = user;
        next()
    }catch(err){
        console.error('Whoami middleware error:', err);
        return res.send({Success:false,Message:"Server Error."})
    }
}

export default whoami