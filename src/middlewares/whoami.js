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
    // console.log(userToken)
    
    // If no cookie, check Authorization header (for Safari/iOS localStorage fallback)
    if(!userToken){
        const authHeader = req.headers['authorization'];
        if(authHeader && authHeader.startsWith('Bearer ')){
            userToken = authHeader.substring(7); // Remove 'Bearer ' prefix
        }
    }

    if(!userToken){
        return res.status(401).send({Success:false,Message:"no user token."})
    }

    try{
        const data = jwt.verify(userToken,process.env.JWT_SECRET);
        if(!data){
            return res.status(401).send({Success:false,Message:"Invalid Token"})
        }

        // The admin token minted in routes/admin/admin.js carries only
        // {isAdmin:true} and is signed with this same secret, so it reaches
        // here with no userID. Mongoose 9 answers findOne({_id: undefined})
        // with null rather than the first document, so this is not currently an
        // impersonation hole — but that is the driver's behaviour protecting
        // us, not ours. Reject explicitly so the guarantee is local.
        if(!data.userID){
            return res.status(401).send({Success:false,Message:"Invalid Token"})
        }

        const user = await USERS.findOne({_id:data.userID});
        if(!user){
            return res.status(401).send({Success:false,Message:'Invalid User ID.'})
        }

        // Password resets bump tokenVersion to cut off sessions issued earlier.
        if((user.tokenVersion || 0) !== (data.tokenVersion || 0)){
            return res.status(401).send({Success:false,Message:"Session expired. Please log in again."})
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
        // An expired or forged token is a client problem, not a server fault;
        // reporting it as "Server Error." kept clients from redirecting to login.
        if(err.name === 'TokenExpiredError'){
            return res.status(401).send({Success:false,Message:"Session expired. Please log in again."})
        }
        if(err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError'){
            return res.status(401).send({Success:false,Message:"Invalid Token"})
        }
        console.error('Whoami middleware error:', err);
        return res.status(500).send({Success:false,Message:"Server Error."})
    }
}

export default whoami