import express from 'express';
import QRCode from '../../models/qrcode.model.js';
import Floor from '../../models/floor.model.js';
import { findShortestRoute } from '../../services/routingService.js';
import { isValidObjectId } from 'mongoose';
import ownerAuth from '../../middlewares/ownerAuth.js';

const router = express.Router();

/**
 * GET /api/route/building/:buildingId/floor/:floorNumber
 * Retrieves floor map data for a specific building and floor
 */
router.get('/building/:buildingId/floor/:floorNumber', async (req, res) => {
  try {
    const { buildingId, floorNumber } = req.params;

    // Validate input
    if (!isValidObjectId(buildingId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid building ID format',
      });
    }

    const floor = parseInt(floorNumber, 10);
    if (isNaN(floor) || floor < 1) {
      return res.status(400).json({
        success: false,
        message: 'Invalid floor number. Must be a positive integer.',
      });
    }

    // Find floor data
    let floorData = await Floor.findOne({
      buildingId,
      floorNumber: floor,
    });

    // If no floor data exists, create a default one
    if (!floorData) {
      
      const defaultSVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" 
     width="1000" 
     height="800" 
     viewBox="0 0 1000 800">
  <!-- Background -->
  <rect width="100%" height="100%" fill="#f8f9fa" stroke="#dee2e6" stroke-width="2"/>
  
  <!-- Floor Title -->
  <text x="500" y="40" text-anchor="middle" font-family="Arial, sans-serif" 
        font-size="24" font-weight="bold" fill="#212529">
    Floor ${floor}
  </text>
  
  <!-- Grid lines for reference -->
  <g stroke="#e9ecef" stroke-width="1">
    ${Array.from({length: 10}, (_, i) => 
      `<line x1="${(i + 1) * 1000/11}" y1="100" x2="${(i + 1) * 1000/11}" y2="700"/>`
    ).join('\n    ')}
    ${Array.from({length: 8}, (_, i) => 
      `<line x1="50" y1="${100 + i * 600/8}" x2="950" y2="${100 + i * 600/8}"/>`
    ).join('\n    ')}
  </g>
  
  <!-- Instructions -->
  <text x="500" y="400" text-anchor="middle" font-family="Arial, sans-serif" 
        font-size="18" fill="#6c757d">
    Upload a floor plan image or SVG to customize this map
  </text>
  
  <!-- Legend -->
  <g transform="translate(50, 720)">
    <rect x="0" y="0" width="15" height="15" fill="#28a745" rx="2"/>
    <text x="20" y="12" font-family="Arial, sans-serif" font-size="12" fill="#495057">Emergency Exit</text>
    
    <rect x="120" y="0" width="15" height="15" fill="#007bff" rx="2"/>
    <text x="140" y="12" font-family="Arial, sans-serif" font-size="12" fill="#495057">Stairs/Elevator</text>
    
    <rect x="260" y="0" width="15" height="15" fill="#ffc107" rx="2"/>
    <text x="280" y="12" font-family="Arial, sans-serif" font-size="12" fill="#495057">Path Point</text>
  </g>
</svg>`;

      floorData = new Floor({
        buildingId,
        floorNumber: floor,
        svgContent: defaultSVG,
        svgMapUrl: `/uploads/floor-maps/${buildingId}-${floor}.svg`,
        width: 1000,
        height: 800
      });
      
      await floorData.save();
    }

    // Validate SVG content
    if (!floorData.svgContent) {
      return res.status(404).json({
        success: false,
        message: 'No SVG content available for this floor',
      });
    }

    return res.status(200).json({
      success: true,
      floor: floorData.floorNumber,
      svgMapUrl: floorData.svgMapUrl,
      svgContent: floorData.svgContent,
      svgDimensions: {
        width: floorData.width || 1000,
        height: floorData.height || 800,
      },
    });
  } catch (error) {
    console.error('Error fetching floor map:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching floor map',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Validate QR ID format
 * @param {string} qrId - QR code identifier
 * @returns {boolean} True if valid
 */
const isValidQRId = (qrId) => {
  return typeof qrId === 'string' && qrId.length > 0 && qrId.length < 500;
};

/**
 * GET /api/route/:qrId
 * Retrieves the shortest emergency exit route for a scanned QR code
 */
router.get('/:qrId', async (req, res) => {
  try {
    const { qrId } = req.params;

    // Validate input
    if (!isValidQRId(qrId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid QR code format',
      });
    }

    // Find QR code record
    const qrCode = await QRCode.findOne({
      code: qrId,
      isActive: true,
    })
      .populate('nodeId')
      .populate('buildingId');

    if (!qrCode) {
      return res.status(404).json({
        success: false,
        message: 'QR code not found or inactive',
      });
    }

    // Validate QR code data
    if (!qrCode.nodeId) {
      return res.status(500).json({
        success: false,
        message: 'QR code has invalid node reference',
      });
    }

    if (!qrCode.buildingId) {
      return res.status(500).json({
        success: false,
        message: 'QR code has invalid building reference',
      });
    }

    // Get floor information for SVG details
    const floor = await Floor.findOne({
      buildingId: qrCode.buildingId._id,
      floorNumber: qrCode.floorNumber,
    });

    // Find shortest route to exit
    let route;
    try {
      route = await findShortestRoute(qrCode.nodeId._id);
    } catch (routeError) {
      if (routeError instanceof Error) {
        return res.status(400).json({
          success: false,
          message: routeError.message,
        });
      }
      throw routeError;
    }

    // Ensure route is valid
    if (!Array.isArray(route) || route.length === 0) {
      return res.status(500).json({
        success: false,
        message: 'Invalid route returned from algorithm',
      });
    }

    // Validate start point coordinates
    if (
      typeof qrCode.nodeId.x !== 'number' ||
      typeof qrCode.nodeId.y !== 'number'
    ) {
      return res.status(500).json({
        success: false,
        message: 'Invalid start point coordinates',
      });
    }

    return res.status(200).json({
      success: true,
      floor: qrCode.floorNumber,
      building: qrCode.buildingId.name || 'Unknown Building',
      svgMapUrl: floor?.svgMapUrl || null,
      svgContent: floor?.svgContent || null,
      svgDimensions: {
        width: floor?.width || 1000,
        height: floor?.height || 800,
      },
      route: route,
      startPoint: {
        x: qrCode.nodeId.x,
        y: qrCode.nodeId.y,
      },
    });
  } catch (error) {
    console.error('Error retrieving route:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to calculate route',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});


export default router;
