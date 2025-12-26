import express from 'express';
const router = express.Router()

router.get('/api/connect',(req,res)=>{
    try{
        return {Success:true,Message:"Connected!"}
    }catch{
        return {Success:false,Message:"Something went wrong."}
    }
})

module.exports = router