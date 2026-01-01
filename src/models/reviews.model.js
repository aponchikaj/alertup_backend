import mongoose from 'mongoose';

const ALERTUP_REVIEWS_SCHEMA = new mongoose.Schema({
    userID:{
        type:mongoose.Schema.Types.ObjectId,
        ref:'Users',
        required:true
    },
    userName:{
        type:String,
        required:true
    },
    userType:{
        type:String,
        enum:['Individual','Company']
    },
    stars:{
        type:Number,
        default:1
    },
    comment:{
        type:String,
    },
    createdAt:{
        type:Date,
        default: Date.now
    }
})

ALERTUP_REVIEWS_SCHEMA.index({ userID: 1 }, { unique: true });

const WEBSITE_REVIEWS = mongoose.model("Alertup_reviews",ALERTUP_REVIEWS_SCHEMA);

export default WEBSITE_REVIEWS;