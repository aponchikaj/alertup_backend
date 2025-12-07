import mongoose from 'mongoose'

const CONTACT_SCHEMA = new mongoose.Schema({
    email:{
        type:String
    },
    message:{
        type:String
    },
    contactType:{
        type:String
    },
    createdAt:{
        type:Date
    }
})

const CONTACTS = mongoose.model('contacts',CONTACT_SCHEMA);
export default CONTACTS