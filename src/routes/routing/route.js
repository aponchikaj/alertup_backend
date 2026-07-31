import express from 'express';
import prisma from '../../db/prisma.js';
import { isId } from '../../utils/ids.js';
import { publicReadLimiter } from '../../services/rateLimiter.js';

const router = express.Router();

// LEGACY COMPATIBILITY: the deployed viewer fetches floor maps here. New
// consumers get floor metadata inside the wayfinding route payloads instead.

const defaultSVG = (floor) => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="1000"
     height="800"
     viewBox="0 0 1000 800">
  <rect width="100%" height="100%" fill="#f8f9fa" stroke="#dee2e6" stroke-width="2"/>
  <text x="500" y="40" text-anchor="middle" font-family="Arial, sans-serif"
        font-size="24" font-weight="bold" fill="#212529">
    Floor ${floor}
  </text>
  <g stroke="#e9ecef" stroke-width="1">
    ${Array.from({ length: 10 }, (_, i) =>
      `<line x1="${((i + 1) * 1000) / 11}" y1="100" x2="${((i + 1) * 1000) / 11}" y2="700"/>`
    ).join('\n    ')}
    ${Array.from({ length: 8 }, (_, i) =>
      `<line x1="50" y1="${100 + (i * 600) / 8}" x2="950" y2="${100 + (i * 600) / 8}"/>`
    ).join('\n    ')}
  </g>
  <text x="500" y="400" text-anchor="middle" font-family="Arial, sans-serif"
        font-size="18" fill="#6c757d">
    Upload a floor plan image or SVG to customize this map
  </text>
</svg>`;

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

    // The building must exist before anything is written for it — this
    // endpoint is public and upserts a placeholder floor.
    const buildingExists = await prisma.building.findUnique({
      where: { id: buildingId },
      select: { id: true },
    });
    if (!buildingExists) {
      return res.status(404).json({
        success: false,
        message: 'Building not found',
      });
    }

    let floorData = await prisma.floor.findUnique({
      where: { buildingId_floorNumber: { buildingId, floorNumber: floor } },
    });

    if (!floorData) {
      // Upsert so two concurrent first-requests can't race the unique index,
      // and an existing floor's map is never overwritten with the placeholder.
      floorData = await prisma.floor.upsert({
        where: { buildingId_floorNumber: { buildingId, floorNumber: floor } },
        create: {
          buildingId,
          floorNumber: floor,
          name: `Floor ${floor}`,
          svgContent: defaultSVG(floor),
          width: 1000,
          height: 800,
        },
        update: {},
      });
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
