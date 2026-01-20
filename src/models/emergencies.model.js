import mongoose from "mongoose";

const EMERGENCIES_SCHEMA = new mongoose.Schema({
    buildingID:{
        type:mongoose.Schema.Types.ObjectId,
        ref:'buildings',
        required:true
    },
    scanned:{
        type:Number,
        default:0
    },
    evacuated:{
        type:Number,
        default:0
    },
    calledEmergency:{
        type:Number,
        default:0
    },
    // emergencyType:{
    //     type:String,
    //     enum:['fire', 'earthquake', 'flood', 'gas', 'lockdown', 'medical', 'other','unknown'],
    //     default:'unknown'
    // },
    triggeredBy: {
        type: String,
        enum: ['admin', 'system', 'manual', 'sensor'],
        default: 'admin'
    },
    isFinished: {
        type: Boolean,
        default: false
    },
    startedAt: {
        type: Date,
        default: Date.now
    },
    endedAt: {
        type: Date
    }
},{timestamps:true})

const EMERGENCIES = mongoose.model('emergency',EMERGENCIES_SCHEMA)
export default EMERGENCIES