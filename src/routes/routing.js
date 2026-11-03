import express from 'express';
import prisma from '../db/prisma.js';
import { isId } from '../utils/ids.js';
import { publicReadLimiter } from '../services/rateLimiter.js';

const router = express.Router();

// LEGACY COMPATIBILITY: the deployed viewer fetches floor maps here. New
// consumers get floor metadata inside the wayfinding route payloads instead.


/**
 * GET /api/route/building/:buildingId/floor/:floorNumber
 * Retrieves floor map data for a specific building and floor.
 */
router.get('/building/:buildingId/floor/:floorNumber', publicReadLimiter, async (req, res) => {
  try {
    const { buildingId, floorNumber } = req.params;

    if (!isId(buildingId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid building ID format',
      });
    }

    // Floor 0 is a legitimate ground floor.
    const floor = parseInt(floorNumber, 10);
    if (isNaN(floor) || floor < 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid floor number. Must be a non-negative integer.',
      });
    }

    // FX-017: read-only. This endpoint is public and anonymous; it used to
    // upsert a placeholder floor for any number asked about, which let anyone
    // add floors to any building past its plan cap. A missing floor is a 404.
    const floorData = await prisma.floor.findUnique({
      where: { buildingId_floorNumber: { buildingId, floorNumber: floor } },
    });
    if (!floorData) {
      return res.status(404).json({ success: false, message: 'Floor not found' });
    }

    if (!floorData.svgContent && !floorData.mapImageUrl) {
      return res.status(404).json({
        success: false,
        message: 'No SVG content available for this floor',
      });
    }

    return res.status(200).json({
      success: true,
      floor: floorData.floorNumber,
      svgMapUrl: floorData.mapImageUrl || `/api/route/building/${buildingId}/floor/${floor}`,
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
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

export default router;
