import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomBytes } from 'crypto';
import ownerAuth from '../../middlewares/ownerAuth.js';
import whoami from '../../middlewares/whoami.js';
import safeFilename from '../../middlewares/safeFilename.js';
import { convertImageToSVG, createBasicSVG, processMultipleImages } from '../../services/svgConverter.js';
import { uploadToCloudinary, deleteFromCloudinary } from '../../services/cloudinaryService.js';

const router = express.Router();

const SVG_DIR = path.join(process.cwd(), 'uploads', 'svg');

const DEFAULT_MAP_WIDTH = 1000;
const DEFAULT_MAP_HEIGHT = 800;

/**
 * Read the intrinsic size of an SVG document.
 * Handles `width="1200"`, `width="1200px"`, and viewBox-only documents.
 *
 * @param {string} svgContent
 * @returns {{width: number, height: number}}
 */
const parseSvgDimensions = (svgContent) => {
  const svgTag = svgContent.slice(svgContent.indexOf('<svg'), svgContent.indexOf('>', svgContent.indexOf('<svg')) + 1);

  const numeric = (value) => {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
  };

  const widthAttr = svgTag.match(/\bwidth\s*=\s*["']([^"']+)["']/i);
  const heightAttr = svgTag.match(/\bheight\s*=\s*["']([^"']+)["']/i);

  let width = widthAttr ? numeric(widthAttr[1]) : null;
  let height = heightAttr ? numeric(heightAttr[1]) : null;

  // Percentage widths (e.g. width="100%") parse to a number but are meaningless
  // here, so fall through to the viewBox in that case.
  if (widthAttr && /%/.test(widthAttr[1])) width = null;
  if (heightAttr && /%/.test(heightAttr[1])) height = null;

  if (!width || !height) {
    const viewBox = svgTag.match(/\bviewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i);
    if (viewBox) {
      width = width || numeric(viewBox[3]);
      height = height || numeric(viewBox[4]);
    }
  }

  return {
    width: width || DEFAULT_MAP_WIDTH,
    height: height || DEFAULT_MAP_HEIGHT,
  };
};

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
// `whoami` runs before multer on every upload route so an unauthenticated
// request is rejected before any bytes are written to disk or sent to
// Cloudinary. These endpoints are not building-scoped (no buildingId in the
// request), so ownerAuth does not apply — authentication is the correct gate.
router.post('/svg', whoami, svgUpload.single('svg'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No SVG file uploaded'
      });
    }

    const svgPath = req.file.path;
    let svgContent;

    try {
      svgContent = fs.readFileSync(svgPath, 'utf8');
    } catch (readError) {
      if (fs.existsSync(svgPath)) {
        fs.unlinkSync(svgPath);
      }
      return res.status(400).json({
        success: false,
        message: 'Failed to read uploaded file'
      });
    }

    if (!svgContent.includes('<svg')) {
      return res.status(400).json({
        success: false,
        message: 'File does not contain valid SVG markup'
      });
    }

    // Derive the drawing dimensions. Prefer explicit width/height attributes,
    // fall back to the viewBox, then to the 1000x800 default used elsewhere in
    // the app (see routes/routing/route.js and building floor-map handling).
    const { width, height } = parseSvgDimensions(svgContent);

    // Upload to Cloudinary
    let cloudinaryUrl = null;
    try {
      const cloudinaryResult = await uploadToCloudinary(
        Buffer.from(svgContent),
        'alertup/svg-maps'
      );
      if (cloudinaryResult && cloudinaryResult.secure_url) {
        cloudinaryUrl = cloudinaryResult.secure_url;
      }
    } catch (cloudinaryError) {
      console.error('Cloudinary upload failed:', cloudinaryError);
    }

    // Return processed SVG data with Cloudinary URL if available
    res.status(200).json({
      success: true,
      message: 'SVG uploaded and validated successfully',
      data: {
        svgContent,
        svgPath: cloudinaryUrl || `/uploads/svg/${req.file.filename}`,
        cloudinaryUrl,
        width,
        height,
        originalName: req.file.originalname,
        size: req.file.size
      }
    });

  } catch (error) {
    console.error('Error uploading SVG:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during SVG upload',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    // ALWAYS clean up the uploaded file
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.error('Error cleaning up file:', cleanupError);
      }
    }
  }
});

/**
 * POST /api/upload/convert
 * Convert image to SVG with proper file saving
 */
router.post('/convert', whoami, imageUpload.single('image'), async (req, res) => {
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
    res.status(500).json({
      success: false,
      message: 'Server error during image conversion',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    // ALWAYS clean up the uploaded image file
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.error('Error cleaning up file:', cleanupError);
      }
    }
  }
});

/**
 * POST /api/upload/convert-multiple
 * Convert multiple images to SVG
 */
router.post('/convert-multiple', whoami, imageUpload.array('images', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No image files uploaded'
      });
    }

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
    res.status(500).json({
      success: false,
      message: 'Server error during multiple image conversion',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    // ALWAYS clean up ALL uploaded files
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
  }
});

/**
 * POST /api/upload/create-basic-svg
 * Create a basic SVG from scratch
 */
router.post('/create-basic-svg', whoami, async (req, res) => {
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
router.get('/svg/:filename', safeFilename(SVG_DIR), (req, res) => {
  if (!fs.existsSync(req.safePath)) {
    return res.status(404).json({
      success: false,
      message: 'File not found'
    });
  }

  res.sendFile(req.safePath);
});

export default router;
