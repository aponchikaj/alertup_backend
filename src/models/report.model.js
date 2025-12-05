import mongoose from 'mongoose'

const REPORT_SCHEMA = new mongoose.Schema({
    email:{
        type:String
    },
    reason:{
        type:String
    },
    message:{
        type:String
    },
    createdAt:{
        type:Date
    }
})

const REPORTS = mongoose.model('reports',REPORT_SCHEMA);
module.exports = REPORTS;