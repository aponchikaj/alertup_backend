import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { uploadToCloudinary } from './cloudinaryService.js';

// The only Cloudinary folder QR deletion is allowed to touch.
export const QR_CLOUDINARY_FOLDER = 'alertup/qr-codes';

/**
 * Generate QR code image file and upload to Cloudinary
 * @param {string} data - QR code data
 * @param {Object} options - QR code generation options
 * @returns {Promise<Object>} - QR code file info
 */
export const generateQRCodeFile = async (data, options = {}) => {
  let tempFilePath = null;
  
  try {
    const {
      size = 300,
      margin = 1,
      color = {
        dark: '#000000',
        light: '#FFFFFF'
      }
    } = options;

    // Generate QR code as buffer (no file creation)
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

    // Upload directly to Cloudinary
    let cloudinaryUrl = null;
    try {
      const cloudinaryResult = await uploadToCloudinary(
        qrBuffer,
        QR_CLOUDINARY_FOLDER
      );
      if (cloudinaryResult && cloudinaryResult.secure_url) {
        cloudinaryUrl = cloudinaryResult.secure_url;
      }
    } catch (cloudinaryError) {
      console.error('❌ Cloudinary upload failed for QR code:', cloudinaryError);
    }

    return {
      success: true,
      url: cloudinaryUrl,
      publicUrl: cloudinaryUrl,
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
 * Generate QR code SVG and upload to Cloudinary
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
      }
    } = options;

    // Generate QR code as SVG string (no file creation)
    const svgString = await QRCode.toString(data, {
      type: 'svg',
      errorCorrectionLevel: 'H',
      margin: margin,
      color: color,
      width: size,
      height: size
    });

    // Upload SVG to Cloudinary
    let cloudinaryUrl = null;
    try {
      const cloudinaryResult = await uploadToCloudinary(
        Buffer.from(svgString),
        QR_CLOUDINARY_FOLDER
      );
      if (cloudinaryResult && cloudinaryResult.secure_url) {
        cloudinaryUrl = cloudinaryResult.secure_url;
      }
    } catch (cloudinaryError) {
      console.error('❌ Cloudinary upload failed for QR SVG:', cloudinaryError);
    }

    return {
      success: true,
      svgContent: svgString,
      url: cloudinaryUrl,
      publicUrl: cloudinaryUrl,
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
 * Generate QR code SVG string (in-memory only)
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

    // Generate QR code as SVG (in-memory only)
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
 * Delete QR code file from Cloudinary
 * @param {string} cloudinaryUrl - Cloudinary URL or public ID
 * @returns {Promise<Object>} - Deletion result
 */
export const deleteQRCodeFile = async (cloudinaryUrl) => {
  try {
    // Extract public_id from Cloudinary URL
    // URL format: https://res.cloudinary.com/{cloud_name}/image/upload/{public_id}.{format}
    if (!cloudinaryUrl || !cloudinaryUrl.includes('cloudinary.com')) {
      return { success: false, message: 'Invalid Cloudinary URL' };
    }

    const urlParts = cloudinaryUrl.split('/');
    const fileWithExt = urlParts[urlParts.length - 1];
    const fileName = fileWithExt.split('.')[0];

    // Reconstruct public_id (includes folder path)
    const uploadIndex = urlParts.indexOf('upload');
    const pathParts = urlParts.slice(uploadIndex + 1, -1);
    const publicId = [...pathParts, fileName].join('/');

    // Scoped to the QR folder. Without this, a caller could hand in the URL of
    // any Cloudinary asset — including another tenant's floor map — and have it
    // deleted, because the derived public_id was used verbatim.
    if (!publicId.startsWith(`${QR_CLOUDINARY_FOLDER}/`)) {
      return { success: false, message: 'Not a QR code asset' };
    }

    // Delete from Cloudinary
    const { deleteFromCloudinary } = await import('./cloudinaryService.js');
    const result = await deleteFromCloudinary(publicId);
    
    return { 
      success: true, 
      message: 'QR code deleted from Cloudinary successfully',
      result 
    };
  } catch (error) {
    console.error('Error deleting QR code from Cloudinary:', error);
    return {
      success: false,
      error: error.message
    };
  }
};