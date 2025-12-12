import mongoose from 'mongoose'

const BUILDINGS_SCHEMA = new mongoose.Schema({
    buildingName:{
        type:String
    },
    owner:{
        type:String
    },
    floors:{
        type:String
    },
    maps:[
        {
            floor:{
                type:String
            },
            map:{
                type:String
            },
            qrCode:{
                type:String
            },
            createdAt:{
                type:String
            },
            scanned:{
                type:Array,
                default:[]
            }
        }
    ],
    scanned:[ 
        {
            userID:{
                type:String
            },
            scannedAt:{
                type:Date
            }
        }
    ],
    updatedAt:{
        type:Date
    },
    isDeactivated:{
        type:Boolean,
        default:false
    }
})

const BUILDINGS = mongoose.model('buildings',BUILDINGS_SCHEMA);
export default BUILDINGS;