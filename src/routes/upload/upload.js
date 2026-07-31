import express from 'express';
import multer from 'multer';
import path from 'path';
import whoami from '../../middlewares/whoami.js';
import {
  convertImageToSVG,
  createBasicSVG,
  processMultipleImages,
} from '../../services/svgConverter.js';
import { uploadBuffer, keys } from '../../services/storage.js';

const router = express.Router();

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
  const svgTag = svgContent.slice(
    svgContent.indexOf('<svg'),
    svgContent.indexOf('>', svgContent.indexOf('<svg')) + 1
  );

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
    const viewBox = svgTag.match(
      /\bviewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i
    );
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

// Memory storage throughout: uploads go straight to S3, never to local disk.
const svgFileFilter = (req, file, cb) => {
  if (
    file.mimetype === 'image/svg+xml' ||
    path.extname(file.originalname).toLowerCase() === '.svg'
  ) {
    cb(null, true);
  } else {
    cb(new Error('Only SVG files are allowed'), false);
  }
};

const imageFileFilter = (req, file, cb) => {
  const allowedTypes = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/bmp',
    'image/webp',
  ];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only image files (JPG, PNG, GIF, BMP, WebP) are allowed'), false);
  }
};

const svgUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: svgFileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

const imageUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: imageFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});

/**
 * POST /api/upload/svg
 *
 * `whoami` runs before multer so an unauthenticated request is rejected before
 * any bytes are read. These endpoints are not building-scoped (no buildingId
 * in the request), so authentication is the correct gate.
 */
router.post('/svg', whoami, svgUpload.single('svg'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No SVG file uploaded' });
    }

    const svgContent = req.file.buffer.toString('utf8');
    if (!svgContent.includes('<svg')) {
      return res.status(400).json({
        success: false,
        message: 'File does not contain valid SVG markup',
      });
    }

    // Prefer explicit width/height, fall back to viewBox, then to the 1000x800
    // default used elsewhere in the app.
    const { width, height } = parseSvgDimensions(svgContent);

    const key = keys.conversion('svg');
    const url = await uploadBuffer({
      key,
      buffer: req.file.buffer,
      contentType: 'image/svg+xml',
    });

    res.status(200).json({
      success: true,
      message: 'SVG uploaded and validated successfully',
      data: {
        svgContent,
        svgPath: url,
        svgUrl: url,
        width,
        height,
        originalName: req.file.originalname,
        size: req.file.size,
      },
    });
  } catch (error) {
    console.error('Error uploading SVG:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during SVG upload',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

/** POST /api/upload/convert — wrap a raster image in an SVG floor map. */
router.post('/convert', whoami, imageUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file uploaded' });
    }

    const conversionResult = await convertImageToSVG(req.file.buffer, {
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      optimize: true,
    });

    if (!conversionResult.success) {
      return res.status(500).json({
        success: false,
        message: 'Failed to convert image to SVG',
        error: conversionResult.error,
      });
    }

    res.status(200).json({
      success: true,
      message: 'Image converted to SVG successfully',
      data: {
        svgContent: conversionResult.svgContent,
        svgPath: conversionResult.svgPath,
        svgUrl: conversionResult.svgUrl,
        svgFilename: conversionResult.svgFilename,
        width: conversionResult.dimensions.width,
        height: conversionResult.dimensions.height,
        originalName: req.file.originalname,
        originalFormat: conversionResult.originalFormat,
        fileSize: conversionResult.fileSize,
      },
    });
  } catch (error) {
    console.error('Error converting image:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during image conversion',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

/** POST /api/upload/convert-multiple */
router.post(
  '/convert-multiple',
  whoami,
  imageUpload.array('images', 10),
  async (req, res) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res
          .status(400)
          .json({ success: false, message: 'No image files uploaded' });
      }

      const results = await processMultipleImages(req.files, { optimize: true });
      const successCount = results.filter((r) => r.success).length;
      const failureCount = results.length - successCount;

      res.status(200).json({
        success: true,
        message: `Processed ${results.length} files. ${successCount} successful, ${failureCount} failed.`,
        data: {
          results,
          summary: {
            total: results.length,
            successful: successCount,
            failed: failureCount,
          },
        },
      });
    } catch (error) {
      console.error('Error converting multiple images:', error);
      res.status(500).json({
        success: false,
        message: 'Server error during multiple image conversion',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  }
);

/** POST /api/upload/create-basic-svg */
router.post('/create-basic-svg', whoami, async (req, res) => {
  try {
    const { width, height, title, buildingName } = req.body;

    const svgResult = await createBasicSVG({
      width: width || DEFAULT_MAP_WIDTH,
      height: height || DEFAULT_MAP_HEIGHT,
      title: title || 'Floor Map',
      buildingName: buildingName || 'Building',
    });

    if (!svgResult.success) {
      return res.status(500).json({
        success: false,
        message: 'Failed to create basic SVG',
        error: svgResult.error,
      });
    }

    res.status(200).json({
      success: true,
      message: 'Basic SVG created successfully',
      data: {
        svgContent: svgResult.svgContent,
        svgPath: svgResult.svgPath,
        svgUrl: svgResult.svgUrl,
        svgFilename: svgResult.svgFilename,
        width: svgResult.dimensions.width,
        height: svgResult.dimensions.height,
        fileSize: svgResult.fileSize,
      },
    });
  } catch (error) {
    console.error('Error creating basic SVG:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during SVG creation',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// GET /api/upload/svg/:filename is gone: uploads now live on S3 and are served
// from their stored URLs, so there is no local file to hand back.

export default router;
