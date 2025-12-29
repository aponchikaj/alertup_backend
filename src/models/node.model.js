import mongoose from 'mongoose';

const nodeSchema = new mongoose.Schema(
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
    x: {
      type: Number,
      required: true,
    },
    y: {
      type: Number,
      required: true,
    },
    type: {
      type: String,
      enum: ['path', 'exit', 'stairs'],
      required: true,
      index: true,
    },
    connections: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Node',
      },
    ],
    label: {
      type: String,
    },
  },
  { timestamps: true }
);

// Index for efficient querying by building and floor
nodeSchema.index({ buildingId: 1, floorNumber: 1 });
// Index for exit queries
nodeSchema.index({ buildingId: 1, floorNumber: 1, type: 1 });

export default mongoose.model('Node', nodeSchema);
