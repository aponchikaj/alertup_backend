import mongoose from 'mongoose'

const VERIFICATION_SCHEMA = new mongoose.Schema({
    verificationType:{
        type:String
    },
    verificationCode:{
        type:String
    },
    // TTL index: Mongo reaps the document once `expires` passes, so an
    // abandoned-but-verified record cannot linger as a standing credential.
    // Routes must still compare `expires` themselves — the TTL monitor only
    // runs about once a minute.
    expires:{
        type:Date,
        default: () => Date.now() + 5*60*1000,
        index: { expires: 0 }
    },
    verificationBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "users",
        required: true,
        index: true,
    },
    verified: {
        type: Boolean,
        default: false,
    },
    // The address an email-change code was mailed to. Verification must prove
    // ownership of *this* address, not whichever one is submitted later.
    pendingEmail: {
        type: String,
        default: null,
    },
    // Wrong-guess counter so a 6-digit code cannot be ground down; the record
    // is destroyed once this passes the per-route limit.
    attempts: {
        type: Number,
        default: 0,
    },
},
{
    timestamps:true
})

const VERIFICATIONS = mongoose.model('verifications',VERIFICATION_SCHEMA);
export default VERIFICATIONS;