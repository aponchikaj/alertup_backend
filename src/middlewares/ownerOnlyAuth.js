import mongoose from 'mongoose';
import BUILDINGS from '../models/building.model.js';
import Node from '../models/node.model.js';

/**
 * Middleware to check if user is the owner of a building
 * Only building owners can access node management (no admin access)
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
const ownerOnlyAuth = async (req, res, next) => {
  try {
    // Check if user is authenticated
    if (!req.user || !req.user._id) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    // Get building ID from request parameters or body.
    // `req.body` is undefined on requests without a parsed body (e.g. DELETE),
    // so it must be accessed optionally — reading it directly threw a
    // TypeError and turned every node deletion into a 500.
    let buildingId = req.params.buildingId || req.params.id || req.body?.buildingId;
    
    // If no buildingId in params/body, try to get it from nodeId
    if (!buildingId && req.params.nodeId) {
      const node = await Node.findById(req.params.nodeId);
      if (!node) {
        return res.status(404).json({
          success: false,
          message: 'Node not found'
        });
      }
      buildingId = node.buildingId;
    }
    
    if (!buildingId) {
      return res.status(400).json({
        success: false,
        message: 'Building ID is required'
      });
    }

    // Checked before querying: a malformed id would otherwise raise a
    // Mongoose CastError and surface as a 500 rather than a 400.
    if (!mongoose.Types.ObjectId.isValid(buildingId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid building ID'
      });
    }

    // Check if user is the building owner
    const building = await BUILDINGS.findById(buildingId);

    if (!building) {
      return res.status(404).json({
        success: false,
        message: 'Building not found'
      });
    }

    // `owner` is not required by the schema, so a building without one must be
    // denied rather than dereferenced.
    if (!building.owner || building.owner.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only the building owner can perform this action.'
      });
    }

    // User is owner, allow access
    req.isAdmin = false;
    req.isOwner = true;
    req.building = building;
    next();
  } catch (error) {
    console.error('Owner auth middleware error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during authorization'
    });
  }
};

export default ownerOnlyAuth;
