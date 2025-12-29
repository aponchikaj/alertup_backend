import BUILDINGS from '../models/building.model.js';
import USERS from '../models/user.model.js';

/**
 * Middleware to check if user is the owner of a building
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
const ownerAuth = async (req, res, next) => {
  try {
    // Check if user is authenticated
    if (!req.user || !req.user._id) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    // Get building ID from request parameters or body
    const buildingId = req.params.buildingId || req.params.id || req.body.buildingId;
    
    if (!buildingId) {
      return res.status(400).json({
        success: false,
        message: 'Building ID is required'
      });
    }

    // Find the building and check ownership
    const building = await BUILDINGS.findById(buildingId);
    
    if (!building) {
      return res.status(404).json({
        success: false,
        message: 'Building not found'
      });
    }

    // Check if user is the owner
    if (building.owner.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only the building owner can perform this action.'
      });
    }

    // Add building to request for use in routes
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

export default ownerAuth;
