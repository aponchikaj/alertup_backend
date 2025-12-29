import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

/**
 * Generate QR code image file
 * @param {string} data - QR code data
 * @param {Object} options - QR code generation options
 * @returns {Promise<Object>} - QR code file info
 */
export const generateQRCodeFile = async (data, options = {}) => {
  try {
    const {
      filename = null,
      directory = 'uploads/qr-codes',
      size = 300,
      margin = 1,
      color = {
        dark: '#000000',
        light: '#FFFFFF'
      }
    } = options;

    // Create directory if it doesn't exist
    const uploadDir = path.join(process.cwd(), directory);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Generate unique filename if not provided
    const finalFilename = filename || `qr-${randomBytes(16).toString('hex')}-${Date.now()}.png`;
    const filePath = path.join(uploadDir, finalFilename);

    // Generate QR code as buffer
    const qrBuffer = await QRCode.toBuffer(data, {
      errorCorrectionLevel: 'H',
      type: 'png',
      quality: 0.92,
      margin: margin,
      color: {
        dark: color.dark,
        light: color.light
      },
      width: size,
      height: size
    });

    // Save QR code file
    fs.writeFileSync(filePath, qrBuffer);

    return {
      success: true,
      filename: finalFilename,
      filePath: filePath,
      url: `/uploads/qr-codes/${finalFilename}`,
      publicUrl: `${process.env.API_BASE_URL || 'http://localhost:3001'}/uploads/qr-codes/${finalFilename}`,
      size: qrBuffer.length,
      dimensions: { width: size, height: size }
    };
  } catch (error) {
    console.error('Error generating QR code file:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

/**
 * Generate QR code SVG file
 * @param {string} data - QR code data
 * @param {Object} options - QR code generation options
 * @returns {Promise<Object>} - QR code SVG file info
 */
export const generateQRCodeSVGFile = async (data, options = {}) => {
  try {
    const {
      size = 300,
      margin = 1,
      color = {
        dark: '#000000',
        light: '#FFFFFF'
      },
      filename = null,
      directory = 'uploads/qr-codes'
    } = options;

    // Create directory if it doesn't exist
    const uploadDir = path.join(process.cwd(), directory);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Generate unique filename if not provided
    const finalFilename = filename || `qr-${randomBytes(16).toString('hex')}-${Date.now()}.svg`;
    const filePath = path.join(uploadDir, finalFilename);

    // Generate QR code as SVG
    const svgString = await QRCode.toString(data, {
      type: 'svg',
      errorCorrectionLevel: 'H',
      margin: margin,
      color: color,
      width: size,
      height: size
    });

    // Save SVG file
    fs.writeFileSync(filePath, svgString, 'utf8');

    return {
      success: true,
      filename: finalFilename,
      filePath: filePath,
      svgContent: svgString,
      url: `/uploads/qr-codes/${finalFilename}`,
      publicUrl: `${process.env.API_BASE_URL || 'http://localhost:3001'}/uploads/qr-codes/${finalFilename}`,
      dimensions: { width: size, height: size }
    };
  } catch (error) {
    console.error('Error generating QR code SVG file:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

/**
 * Generate QR code SVG string
 * @param {string} data - QR code data
 * @param {Object} options - QR code generation options
 * @returns {Promise<Object>} - QR code SVG info
 */
export const generateQRCodeSVG = async (data, options = {}) => {
  try {
    const {
      size = 300,
      margin = 1,
      color = {
        dark: '#000000',
        light: '#FFFFFF'
      }
    } = options;

    // Generate QR code as SVG
    const svgString = await QRCode.toString(data, {
      type: 'svg',
      errorCorrectionLevel: 'H',
      margin: margin,
      color: color,
      width: size,
      height: size
    });

    return {
      success: true,
      svgContent: svgString,
      dimensions: { width: size, height: size }
    };
  } catch (error) {
    console.error('Error generating QR code SVG:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

/**
 * Delete QR code file
 * @param {string} filename - QR code filename
 * @returns {Promise<Object>} - Deletion result
 */
export const deleteQRCodeFile = async (filename) => {
  try {
    const filePath = path.join(process.cwd(), 'uploads', 'qr-codes', filename);
    
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return { success: true, message: 'QR code file deleted successfully' };
    }
    
    return { success: false, message: 'QR code file not found' };
  } catch (error) {
    console.error('Error deleting QR code file:', error);
    return {
      success: false,
      error: error.message
    };
  }
};
