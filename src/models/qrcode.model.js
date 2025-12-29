import mongoose from 'mongoose';

const qrCodeSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    buildingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'buildings',
      required: true,
      index: true,
    },
    floorNumber: {
      type: Number,
      required: true,
    },
    nodeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Node',
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true }
);

// Index for efficient querying by code
qrCodeSchema.index({ code: 1, isActive: 1 });
const QR_CODES = mongoose.model('QRCode', qrCodeSchema);

export default QR_CODES
