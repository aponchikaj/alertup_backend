const isAdmin = (req,res,next)=>{
    try{
        const adminToken = req.cookies['adminToken']

        if(!adminToken){
            req.isAdmin=false
            return res.send({Success:false,Message:"Admin token not found."})
        }

        req.isAdmin = true
        next();
    }catch{
        req.isAdmin = false
        return res.send({Success:false,Message:"Server error. Admin checking error."})
    }
}

export default isAdmin