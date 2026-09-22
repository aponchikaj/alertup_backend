import express from 'express';
const router = express.Router()

router.get('/api/connect',(req,res)=>{
    try{
        return res.send({
            Success: true,
            Message: 'Connected.',
            timestamp: new Date().toISOString()
        });
    }catch(err){
        console.error('[Connect] Error:', err);
        return res.send({
            Success: false,
            Message: "Something went wrong.",
            error: err.message
        });
    }
})

export default router;