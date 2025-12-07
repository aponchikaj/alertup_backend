import jwt from 'jsonwebtoken'
import USERS from '../models/user.model'

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

        req.user = user;
        next()
    }catch{
        return res.send({Success:false,Message:"Server Error."})
    }
}

export default whoami