import mongoose from 'mongoose'

const MAP_SCHEMA = new mongoose.Schema({
  floor: String,
  map: String,
  qrCode: String,
  createdAt: { type: Date, default: Date.now },
  scanned: {type:Number,default:0}
})

const GLOBAL_SCAN_SCHEMA = new mongoose.Schema({
  userID: String,
  scannedAt: { type: Date, default: Date.now }
})

const BUILDINGS_SCHEMA = new mongoose.Schema({
  buildingName: String,
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
  floors: Number,
  maps: [MAP_SCHEMA],
  globalScans: [GLOBAL_SCAN_SCHEMA],
  updatedAt: { type: Date, default: Date.now },
  isDeactivated: { type: Boolean, default: false }
})

BUILDINGS_SCHEMA.index({ owner: 1 })
BUILDINGS_SCHEMA.index({ buildingName: 1 })

const BUILDINGS = mongoose.model('buildings', BUILDINGS_SCHEMA)
export default BUILDINGS