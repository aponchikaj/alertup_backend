import jwt from 'jsonwebtoken'
import USERS from '../models/user.model.js'

const whoami = async(req,res,next)=>{
    const userToken = req.cookies['userToken']

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
    }catch{
        return res.send({Success:false,Message:"Server Error."})
    }
}

export default whoami