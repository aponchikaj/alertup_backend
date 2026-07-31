import express from 'express';
import path from 'path';
import fs from 'fs';
import { generateQRCodeFile, generateQRCodeSVGFile, generateQRCodeSVG, deleteQRCodeFile } from '../../services/qrService.js';
import ownerAuth from '../../middlewares/ownerAuth.js';
import whoami from '../../middlewares/whoami.js';
import safeFilename from '../../middlewares/safeFilename.js';
import 'dotenv/config';

const router = express.Router();

const QR_CODE_DIR = path.join(process.cwd(), 'uploads', 'qr-codes');

/**
 * POST /api/qr/generate
 * Generate QR code image for a node
 */
router.post('/api/qr/generate', whoami, ownerAuth, async (req, res) => {
  try {
    const { nodeId, buildingId, floorNumber, format = 'png' } = req.body;
    
    // Validate required fields.
    // floorNumber is checked for presence rather than truthiness: node creation
    // accepts floor 0 as a legitimate ground floor, so `!floorNumber` made it
    // impossible to generate a QR code for one.
    if (!nodeId || !buildingId || floorNumber === undefined || floorNumber === null || floorNumber === '') {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: nodeId, buildingId, floorNumber'
      });
    }

    // Validate format
    if (!['png', 'svg'].includes(format)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid format. Must be "png" or "svg"'
      });
    }

    // Generate QR code data
    const qrData = `${process.env.CLIENT_SCAN_QR_URL || 'http://localhost:5173'}/scan/route/qr_${buildingId}_${floorNumber}_${nodeId}`;
    
    let result;
    
    if (format === 'svg') {
      result = await generateQRCodeSVGFile(qrData, {
        size: 300,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      });
    } else {
      result = await generateQRCodeFile(qrData, {
        size: 300,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      });
    }

    if (!result.success) {
      return res.status(500).json({
        success: false,
        message: 'Failed to generate QR code',
        error: result.error
      });
    }

    res.status(200).json({
      success: true,
      message: 'QR code generated successfully',
      data: {
        qrData,
        format,
        filename: result.filename || null,
        url: result.publicUrl || result.url,
        svgContent: result.svgContent || null,
        dimensions: result.dimensions,
        size: result.size || null
      }
    });

  } catch (error) {
    console.error('Error generating QR code:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during QR code generation',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// The GET /api/qr/file/:filename and GET /api/qr/download/:filename routes
// were removed. QR codes are generated in memory and uploaded to Cloudinary —
// nothing is ever written to uploads/qr-codes/ — so both could only ever 404.
// The download route was doubly dead: ownerAuth reads buildingId from the body
// or route params, and it had neither, so every call returned 400.

/**
 * DELETE /api/qr/:buildingId/:qrUrl
 * Delete a QR code asset belonging to a building the caller owns.
 *
 * buildingId is a route param so ownerAuth can authorize the request; it
 * previously had to arrive in the DELETE body, which no client sent.
 */
router.delete('/api/qr/:buildingId/:qrUrl', whoami, ownerAuth, async (req, res) => {
  try {
    const qrUrl = decodeURIComponent(req.params.qrUrl);

    // Owning *a* building is not enough — the asset itself must belong to this
    // building. Without this check the URL of any Cloudinary asset could be
    // passed in and deleted, including another tenant's floor map.
    const ownsAsset = (req.building?.maps || []).some((m) => m.qrCode === qrUrl);
    if (!ownsAsset) {
      return res.status(403).json({
        success: false,
        message: 'That QR code does not belong to this building'
      });
    }

    const result = await deleteQRCodeFile(qrUrl);

    if (!result.success) {
      return res.status(404).json({
        success: false,
        message: result.message
      });
    }

    res.status(200).json({
      success: true,
      message: result.message
    });

  } catch (error) {
    console.error('Error deleting QR code:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during QR code deletion',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

export default router;
