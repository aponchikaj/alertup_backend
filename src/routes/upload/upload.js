import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomBytes } from 'crypto';
import ownerAuth from '../../middlewares/ownerAuth.js';
import { convertImageToSVG, createBasicSVG, processMultipleImages } from '../../services/svgConverter.js';
import { uploadToCloudinary, deleteFromCloudinary } from '../../services/cloudinaryService.js';

const router = express.Router();

// Configure multer for SVG uploads
const svgStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(process.cwd(), 'uploads', 'svg');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${randomBytes(16).toString('hex')}-${Date.now()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

// Configure multer for image uploads
const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(process.cwd(), 'uploads', 'images');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${randomBytes(16).toString('hex')}-${Date.now()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const svgFileFilter = (req, file, cb) => {
  // Only allow SVG files
  if (file.mimetype === 'image/svg+xml' || path.extname(file.originalname).toLowerCase() === '.svg') {
    cb(null, true);
  } else {
    cb(new Error('Only SVG files are allowed'), false);
  }
};

const imageFileFilter = (req, file, cb) => {
  // Accept common image formats
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/bmp', 'image/webp'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only image files (JPG, PNG, GIF, BMP, WebP) are allowed'), false);
  }
};

const svgUpload = multer({
  storage: svgStorage,
  fileFilter: svgFileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  }
});

const imageUpload = multer({
  storage: imageStorage,
  fileFilter: imageFileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  }
});

/**
 * POST /api/upload/svg
 * Upload and process SVG file for building floor
 */
router.post('/svg', svgUpload.single('svg'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No SVG file uploaded'
      });
    }

    // Read the uploaded SVG file
    const svgPath = req.file.path;
    let svgContent;

    try {
      svgContent = fs.readFileSync(svgPath, 'utf8');
    } catch (readError) {
      // Clean up file if read fails
      if (fs.existsSync(svgPath)) {
        fs.unlinkSync(svgPath);
      }
      return res.status(400).json({
        success: false,
        message: 'Failed to read uploaded file'
      });
    }

    // Validate SVG content
    if (!svgContent || !svgContent.trim()) {
      // Clean up invalid file
      if (fs.existsSync(svgPath)) {
        fs.unlinkSync(svgPath);
      }
      return res.status(400).json({
        success: false,
        message: 'SVG file is empty or corrupted'
      });
    }

    // Check if it's actually SVG content
    const trimmedContent = svgContent.trim();
    if (!trimmedContent.startsWith('<svg') || !trimmedContent.endsWith('</svg>')) {
      // Clean up invalid file
      if (fs.existsSync(svgPath)) {
        fs.unlinkSync(svgPath);
      }
      return res.status(400).json({
        success: false,
        message: 'Invalid SVG file format. File must start with <svg> and end with </svg>'
      });
    }

    // Basic SVG security validation
    const dangerousPatterns = [
      /<script[^>]*>.*?<\/script>/gi,
      /javascript:/gi,
      /on\w+\s*=/gi,
      /<iframe[^>]*>.*?<\/iframe>/gi,
      /<object[^>]*>.*?<\/object>/gi,
      /<embed[^>]*>/gi,
      /<form[^>]*>.*?<\/form>/gi
    ];

    const hasDangerousContent = dangerousPatterns.some(pattern => pattern.test(svgContent));
    if (hasDangerousContent) {
      // Clean up dangerous file
      if (fs.existsSync(svgPath)) {
        fs.unlinkSync(svgPath);
      }
      return res.status(400).json({
        success: false,
        message: 'SVG file contains potentially dangerous content'
      });
    }

    // Extract dimensions from SVG or set defaults
    const widthMatch = svgContent.match(/width="([^"]+)"/);
    const heightMatch = svgContent.match(/height="([^"]+)"/);
    const viewBoxMatch = svgContent.match(/viewBox="([^"]+)"/);
    
    let width = 1000;
    let height = 800;

    if (widthMatch) {
      const parsedWidth = parseInt(widthMatch[1]);
      if (!isNaN(parsedWidth) && parsedWidth > 0) {
        width = parsedWidth;
      }
    }

    if (heightMatch) {
      const parsedHeight = parseInt(heightMatch[1]);
      if (!isNaN(parsedHeight) && parsedHeight > 0) {
        height = parsedHeight;
      }
    }

    // If viewBox exists, use it for dimensions
    if (viewBoxMatch) {
      const viewBoxParts = viewBoxMatch[1].split(' ');
      if (viewBoxParts.length === 4) {
        const viewBoxWidth = parseFloat(viewBoxParts[2]);
        const viewBoxHeight = parseFloat(viewBoxParts[3]);
        if (!isNaN(viewBoxWidth) && !isNaN(viewBoxHeight) && viewBoxWidth > 0 && viewBoxHeight > 0) {
          width = Math.round(viewBoxWidth);
          height = Math.round(viewBoxHeight);
        }
      }
    }

    // Validate dimensions
    if (width > 5000 || height > 5000) {
      return res.status(400).json({
        success: false,
        message: 'SVG dimensions too large. Maximum allowed is 5000x5000 pixels.'
      });
    }

    // Return processed SVG data
    res.status(200).json({
      success: true,
      message: 'SVG uploaded and validated successfully',
      data: {
        svgContent,
        svgPath: `/uploads/svg/${req.file.filename}`,
        width,
        height,
        originalName: req.file.originalname,
        size: req.file.size
      }
    });

  } catch (error) {
    console.error('Error uploading SVG:', error);
    
    // Clean up uploaded file on error
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.error('Error cleaning up file:', cleanupError);
      }
    }

    res.status(500).json({
      success: false,
      message: 'Server error during SVG upload',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * POST /api/upload/convert
 * Convert image to SVG with proper file saving
 */
router.post('/convert', imageUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No image file uploaded'
      });
    }

    // Convert image to SVG
    const conversionResult = await convertImageToSVG(req.file.path, {
      filename: req.file.originalname.replace(/\.[^/.]+$/, ''),
      quality: 90,
      optimize: true,
      baseUrl: `${req.protocol}://${req.get('host')}`
    });

    if (!conversionResult.success) {
      // Clean up uploaded file on error
      if (req.file.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(500).json({
        success: false,
        message: 'Failed to convert image to SVG',
        error: conversionResult.error
      });
    }

    res.status(200).json({
      success: true,
      message: 'Image converted to SVG successfully',
      data: {
        svgContent: conversionResult.svgContent,
        svgPath: conversionResult.svgPath,
        svgFilename: conversionResult.svgFilename,
        width: conversionResult.dimensions.width,
        height: conversionResult.dimensions.height,
        originalName: req.file.originalname,
        originalFormat: conversionResult.originalFormat,
        fileSize: conversionResult.fileSize
      }
    });

  } catch (error) {
    console.error('Error converting image:', error);
    
    // Clean up uploaded file on error
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.error('Error cleaning up file:', cleanupError);
      }
    }

    res.status(500).json({
      success: false,
      message: 'Server error during image conversion',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * POST /api/upload/convert-multiple
 * Convert multiple images to SVG
 */
router.post('/convert-multiple', imageUpload.array('images', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No image files uploaded'
      });
    }

    // Process multiple images
    const results = await processMultipleImages(req.files, {
      quality: 90,
      optimize: true,
      baseUrl: `${req.protocol}://${req.get('host')}`
    });

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.length - successCount;

    res.status(200).json({
      success: true,
      message: `Processed ${results.length} files. ${successCount} successful, ${failureCount} failed.`,
      data: {
        results,
        summary: {
          total: results.length,
          successful: successCount,
          failed: failureCount
        }
      }
    });

  } catch (error) {
    console.error('Error converting multiple images:', error);
    
    // Clean up uploaded files on error
    if (req.files) {
      req.files.forEach(file => {
        if (file.path && fs.existsSync(file.path)) {
          try {
            fs.unlinkSync(file.path);
          } catch (cleanupError) {
            console.error('Error cleaning up file:', cleanupError);
          }
        }
      });
    }

    res.status(500).json({
      success: false,
      message: 'Server error during multiple image conversion',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * POST /api/upload/create-basic-svg
 * Create a basic SVG from scratch
 */
router.post('/create-basic-svg', async (req, res) => {
  try {
    const { width, height, title, buildingName } = req.body;

    // Create basic SVG
    const svgResult = await createBasicSVG({
      width: width || 1000,
      height: height || 800,
      title: title || 'Floor Map',
      buildingName: buildingName || 'Building'
    });

    if (!svgResult.success) {
      return res.status(500).json({
        success: false,
        message: 'Failed to create basic SVG',
        error: svgResult.error
      });
    }

    res.status(200).json({
      success: true,
      message: 'Basic SVG created successfully',
      data: {
        svgContent: svgResult.svgContent,
        svgPath: svgResult.svgPath,
        svgFilename: svgResult.svgFilename,
        width: svgResult.dimensions.width,
        height: svgResult.dimensions.height,
        fileSize: svgResult.fileSize
      }
    });

  } catch (error) {
    console.error('Error creating basic SVG:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during SVG creation',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /api/uploads/svg/:filename
 * Serve uploaded SVG files
 */
router.get('/svg/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(process.cwd(), 'uploads', 'svg', filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      success: false,
      message: 'File not found'
    });
  }

  res.sendFile(filePath);
});

export default router;
