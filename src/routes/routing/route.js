import express from 'express';
import Floor from '../../models/floor.model.js';
import BUILDINGS from '../../models/building.model.js';
import { isValidObjectId } from 'mongoose';
import { publicReadLimiter } from '../../services/rateLimiter.js';

const router = express.Router();

// Note: this router used to also expose GET /api/route/:qrId, which resolved a
// QRCode document by code. Nothing in the application ever created those
// documents, so that endpoint could only ever 404. Scanning is handled by
// /api/qr/scan/route/:qrId, which parses the self-describing qr_ id instead.

/**
 * GET /api/route/building/:buildingId/floor/:floorNumber
 * Retrieves floor map data for a specific building and floor
 */
router.get('/building/:buildingId/floor/:floorNumber', publicReadLimiter, async (req, res) => {
  try {
    const { buildingId, floorNumber } = req.params;

    // Validate input
    if (!isValidObjectId(buildingId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid building ID format',
      });
    }

    // Floor 0 is a legitimate ground floor — node creation accepts it, so
    // rejecting it here made ground-floor maps unreachable.
    const floor = parseInt(floorNumber, 10);
    if (isNaN(floor) || floor < 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid floor number. Must be a non-negative integer.',
      });
    }

    // The building must exist before anything is written for it. This endpoint
    // is public and used to persist a new Floor document for *any* well-formed
    // ObjectId and floor number, so a script walking random ids could fill the
    // collection with orphaned documents.
    const buildingExists = await BUILDINGS.exists({ _id: buildingId });
    if (!buildingExists) {
      return res.status(404).json({
        success: false,
        message: 'Building not found',
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

      // Upserted rather than saved: two concurrent first-requests for the same
      // floor both reached the create path and one lost to the unique index,
      // returning a 500. $setOnInsert also means an existing floor's map is
      // never overwritten with the placeholder.
      floorData = await Floor.findOneAndUpdate(
        { buildingId, floorNumber: floor },
        {
          $setOnInsert: {
            buildingId,
            floorNumber: floor,
            svgContent: defaultSVG,
            // Points at the inline svgContent above; there is no file behind
            // this path, and nothing in the app writes one.
            svgMapUrl: `/api/route/building/${buildingId}/floor/${floor}`,
            width: 1000,
            height: 800,
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );
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

export default router;
