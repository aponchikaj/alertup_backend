import express from 'express';
const router = express.Router()

router.get('/api/connect',(req,res)=>{
    try{
        return res.send({Success:true,Message:'Connected.'})
    }catch{
        return res.send({Success:false,Message:"Something went wrong."})
    }
})

export default router;