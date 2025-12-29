import mongoose from 'mongoose';

const floorSchema = new mongoose.Schema(
  {
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
    svgMapUrl: {
      type: String,
      required: true,
    },
    svgContent: {
      type: String,
    },
    width: {
      type: Number,
    },
    height: {
      type: Number,
    },
  },
  { timestamps: true }
);

// Ensure unique floor per building
floorSchema.index({ buildingId: 1, floorNumber: 1 }, { unique: true });

export default mongoose.model('Floor', floorSchema);
