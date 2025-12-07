import mongoose from 'mongoose'

const VERIFICATION_SCHEMA = new mongoose.Schema({
    verificationType:{
        type:String
    },
    verificationCode:{
        type:String
    },
    expires:{
        type:Date,
        default: () => Date.now() + 5*60*1000
    },
    verificationBy:{
        type:String
    }
})

const VERIFICATIONS = mongoose.model('verifications',VERIFICATION_SCHEMA);
export default VERIFICATIONS;