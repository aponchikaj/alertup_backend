import express from 'express';
import path from 'path';
import fs from 'fs';
import { generateQRCodeFile, generateQRCodeSVGFile, generateQRCodeSVG, deleteQRCodeFile } from '../../services/qrService.js';
import ownerAuth from '../../middlewares/ownerAuth.js';
import whoami from '../../middlewares/whoami.js';
import 'dotenv/config';

const router = express.Router();

/**
 * POST /api/qr/generate
 * Generate QR code image for a node
 */
router.post('/api/qr/generate', whoami, ownerAuth, async (req, res) => {
  try {
    const { nodeId, buildingId, floorNumber, format = 'png' } = req.body;
    
    // Validate required fields
    if (!nodeId || !buildingId || !floorNumber) {
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

/**
 * GET /api/qr/file/:filename
 * Serve QR code image file directly
 */
router.get('/api/qr/file/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(process.cwd(), 'uploads', 'qr-codes', filename);
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: 'QR code file not found'
      });
    }

    // Set appropriate headers
    const ext = filename.split('.').pop().toLowerCase();
    const contentType = ext === 'svg' ? 'image/svg+xml' : 'image/png';
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
    
    // Send file
    if (ext === 'svg') {
      const svgContent = fs.readFileSync(filePath, 'utf8');
      res.send(svgContent);
    } else {
      res.sendFile(filePath);
    }

  } catch (error) {
    console.error('Error serving QR code file:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while serving QR code file',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /api/qr/download/:filename
 * Download QR code image file
 */
router.get('/api/qr/download/:filename', whoami, ownerAuth, async (req, res) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(process.cwd(), 'uploads', 'qr-codes', filename);
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: 'QR code file not found'
      });
    }

    // Set appropriate headers
    const ext = filename.split('.').pop().toLowerCase();
    const contentType = ext === 'svg' ? 'image/svg+xml' : 'image/png';
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    // Send file
    if (ext === 'svg') {
      const svgContent = fs.readFileSync(filePath, 'utf8');
      res.send(svgContent);
    } else {
      res.sendFile(filePath);
    }

  } catch (error) {
    console.error('Error downloading QR code:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during QR code download',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * DELETE /api/qr/:filename
 * Delete QR code file
 */
router.delete('/api/qr/:filename', whoami, ownerAuth, async (req, res) => {
  try {
    const { filename } = req.params;
    
    const result = await deleteQRCodeFile(filename);
    
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
