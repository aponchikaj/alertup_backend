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
                type:Array
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
    }
})

const BUILDINGS = mongoose.model('buildings',BUILDINGS_SCHEMA);
module.exports = BUILDINGS;