const isAdmin = (req,res,next)=>{
    try{
        const adminToken = req.cookies['adminToken']

        if(!adminToken){
            return res.send({Success:false,Message:"Admin token not found."})
        }

        next();
    }catch{
        return res.send({Success:false,Message:"Server error. Admin checking error."})
    }
}

export default isAdmin