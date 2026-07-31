import mongoose from 'mongoose'

const USER_SCHEMA = new mongoose.Schema({
    name:{
        type:String,
        default:""
    },
    lastname:{
        type:String,
        default:""
    },
    company:{
        type:String,
        default:""
    },
    password:{
        type:String,
        // Never returned by default; an admin route was serving the bcrypt hash
        // to the browser because it forgot to exclude it.
        select:false
    },
    email:{
        type:String,
        // Normalized and unique so Foo@x.com and foo@x.com cannot become two
        // accounts, and so a check-then-insert race cannot create duplicates
        // that would make login resolve to an arbitrary one of them.
        unique:true,
        lowercase:true,
        trim:true,
        index:true
    },
    // Bumped on password reset to invalidate sessions issued beforehand.
    tokenVersion:{
        type:Number,
        default:0
    },
    country:{
        type:String
    },
    countryCode:{
        type:String
    },
    phones:{
        type:String,
    },
    Buildings: [
        {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'buildings'
        }
    ],
    updatedAt:{
        type:Date,
        // A factory, not a value: the previous form was evaluated once at module
        // load, so every user created during a process's lifetime was stamped
        // with the server's start time.
        default: () => new Date()
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
                type:mongoose.Schema.Types.ObjectId,
                ref:'buildings'
            }
        }
    ],
    verified:{
        type:Boolean,
        default:false
    },
    premium:{
        hasPremium:{
            type:Boolean,
            default:false
        },
        premiumType:{
            type:String,
            default:''
        },
        subscriptionId:{
            type:String,
            default:null
        },
        from:{
            type:Date,
        },
        to:{
            type:Date
        }
    },
    transactions:{
        type:Array
    },
    userType:{
        type:String,
        enum:['Individual','Company']
    },
    TwoFactorEnabled:{
        type:Boolean,
        default:false
    },
    trustedIPS:{
      type:[String],
      default:[]
    }
})

const USERS = mongoose.model('users',USER_SCHEMA);
export default USERS;
