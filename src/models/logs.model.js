import mongoose from 'mongoose';

const LOGS_SCHEMA = new mongoose.Schema({
  logType:{
    type:String,
    required:true,
    default:"system",
    enum:["system","report","error","scan","evacuated"]
  },
  logMessage:{
    type:String,
    required:true,
  },
  createdAt:{
    type:Date,
    default: Date.now,
  },
  isEmergency:{
    type:Boolean,
    default:false,
  },
},{timestamps:true})

const LOGS = mongoose.model('log',LOGS_SCHEMA)
export default LOGS;
