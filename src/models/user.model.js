import mongoose from 'mongoose'

const USER_SCHEMA = new mongoose.Schema({
    username:{
        type:String
    },
    password:{
        type:String
    },
    email:{
        type:String
    },
    country:{
        type:String
    },
    countryCode:{
        type:String
    },
    phones:{
        type:Array,
        default:[]
    },
    Buildings:[
        {
            buildingName:{
                type:String
            },
            buildingID:{
                type:String
            }
        }
    ],
    updatedAt:{
        type:Date,
        default:`${new Date().toISOString()}`
    },
    notifications:[
        {
            Title:{
                type:String
            },
            summary:{
                type:String
            },
            to:{
                type:String
            }
        }
    ],
    scanned:[
        {
            buildingName:{
                type:String
            },
            scannedAt:{
                type:String
            },
            buildingID:{
                type:String
            },
            scannedCount:{
                type:Number
            }
        }
    ],
    verified:{
        type:Boolean,
        default:false
    }
})

const USERS = mongoose.model('users',USER_SCHEMA);
export default USERS;