import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

/**
 * Reduce a caller-supplied name to a single safe path segment.
 *
 * Strips any directory component and every character that could escape the
 * upload directory or alter the extension. Returns '' when nothing usable is
 * left, so callers fall back to a generated name.
 */
export const sanitizeBaseName = (name) => {
  if (typeof name !== 'string') return '';
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '').replace(/^\.+/, '').slice(0, 100);
};

/**
 * Escape text before interpolating it into SVG/XML.
 *
 * Generated SVGs are written under uploads/ and served from the API origin as
 * image/svg+xml, so an unescaped value carrying `</text><script>…` would be a
 * stored XSS hosted on the API domain.
 */
export const escapeXml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * Convert image to SVG with proper file saving
 * @param {string} imagePath - Path to the uploaded image
 * @param {Object} options - Conversion options
 * @returns {Promise<Object>} - Conversion result
 */
export const convertImageToSVG = async (imagePath, options = {}) => {
  try {
    const {
      filename = null,
      directory = 'uploads/svg-converted',
      quality = 90,
      optimize = true,
      baseUrl = process.env.API_BASE_URL || 'http://localhost:3001'
    } = options;

    // Create directory if it doesn't exist
    const uploadDir = path.join(process.cwd(), directory);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Generate unique filename if not provided.
    //
    // `filename` is derived from the client-supplied multipart originalname, so
    // it is run through path.basename and stripped of anything but safe
    // characters. Passing it to path.join unsanitized let a file named
    // "../../server.js.png" write its .svg outside the upload directory.
    const requestedName = filename ? sanitizeBaseName(filename) : '';
    const baseFilename = requestedName || `converted-${randomBytes(8).toString('hex')}-${Date.now()}`;
    const svgFilename = `${baseFilename}.svg`;
    const svgPath = path.join(uploadDir, svgFilename);

    // Get image filename for reference
    const imageFilename = path.basename(imagePath);
    const imageExt = path.extname(imagePath);
    
    // Try to get image dimensions (basic approach)
    let width = 1000;
    let height = 800;
    
    try {
      // For a real implementation, you'd use sharp or jimp to read image dimensions
      // For now, we'll use reasonable defaults
      if (imageExt.toLowerCase() === '.png' || imageExt.toLowerCase() === '.jpg' || imageExt.toLowerCase() === '.jpeg') {
        width = 1200;
        height = 900;
      }
    } catch (dimError) {
      // Could not determine image dimensions, using defaults
    }

    // The image is embedded as a data URI rather than linked. The caller
    // deletes the uploaded source file as soon as this returns, so an
    // `/uploads/images/...` reference always resolved to a missing file and
    // every converted SVG rendered as an empty rectangle.
    const mimeByExt = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };
    const mimeType = mimeByExt[imageExt.toLowerCase()] || 'image/png';
    const imageUrl = `data:${mimeType};base64,${fs.readFileSync(imagePath).toString('base64')}`;
    const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" 
     xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${width}" 
     height="${height}" 
     viewBox="0 0 ${width} ${height}">
  <defs>
    <pattern id="floor-pattern" patternUnits="userSpaceOnUse" width="${width}" height="${height}">
      <image xlink:href="${imageUrl}" 
             x="0" y="0" 
             width="${width}" 
             height="${height}" 
             preserveAspectRatio="xMidYMid meet"/>
    </pattern>
  </defs>
  
  <!-- Background with image -->
  <rect width="100%" height="100%" fill="url(#floor-pattern)" stroke="#333" stroke-width="2"/>
  
  <!-- Grid overlay for navigation reference -->
  <g stroke="#ffffff20" stroke-width="0.5" fill="none">
    ${Array.from({length: 20}, (_, i) => 
      `<line x1="${(i + 1) * width/21}" y1="0" x2="${(i + 1) * width/21}" y2="${height}"/>`
    ).join('\n    ')}
    ${Array.from({length: 15}, (_, i) => 
      `<line x1="0" y1="${(i + 1) * height/16}" x2="${width}" y2="${(i + 1) * height/16}"/>`
    ).join('\n    ')}
  </g>
  
  <!-- Metadata -->
  <metadata>
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
             xmlns:dc="http://purl.org/dc/elements/1.1/">
      <rdf:Description about="">
        <dc:title>Converted Floor Map</dc:title>
        <dc:description>Floor map converted from ${imageExt} for AlertUp emergency routing</dc:description>
        <dc:date>${new Date().toISOString()}</dc:date>
        <dc:format>image/svg+xml</dc:format>
        <dc:source>${escapeXml(imageFilename)}</dc:source>
        <dc:dimensions>${width}x${height}</dc:dimensions>
      </rdf:Description>
    </rdf:RDF>
  </metadata>
</svg>`.trim();

    // Optimize SVG if requested
    let finalSvgContent = svgContent;
    if (optimize) {
      finalSvgContent = optimizeSVG(svgContent);
    }

    // Save SVG file
    fs.writeFileSync(svgPath, finalSvgContent, 'utf8');

    return {
      success: true,
      svgPath,
      svgFilename,
      svgContent: finalSvgContent,
      originalFormat: imageExt.replace('.', ''),
      dimensions: { width, height },
      fileSize: fs.statSync(svgPath).size
    };

  } catch (error) {
    console.error('Error converting image to SVG:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

/**
 * Optimize SVG content by removing unnecessary elements
 * @param {string} svgContent - Raw SVG content
 * @returns {string} - Optimized SVG content
 */
const optimizeSVG = (svgContent) => {
  return svgContent
    // Remove comments
    .replace(/<!--[\s\S]*?-->/g, '')
    // Remove extra whitespace
    .replace(/\s+/g, ' ')
    // Remove empty lines
    .replace(/>\s+</g, '><')
    .trim();
};

/**
 * Create a basic SVG from scratch (when no image is provided)
 * @param {Object} options - SVG creation options
 * @returns {Promise<Object>} - SVG creation result
 */
export const createBasicSVG = async (options = {}) => {
  try {
    const {
      filename = null,
      directory = 'uploads/svg-generated',
      width = 1000,
      height = 800,
      title = 'Floor Map',
      buildingName = 'Building'
    } = options;

    // Create directory if it doesn't exist
    const uploadDir = path.join(process.cwd(), directory);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Generate unique filename (sanitized — see convertImageToSVG).
    const requestedName = filename ? sanitizeBaseName(filename) : '';
    const baseFilename = requestedName || `floor-map-${randomBytes(8).toString('hex')}-${Date.now()}`;
    const svgFilename = `${baseFilename}.svg`;
    const svgPath = path.join(uploadDir, svgFilename);

    // These come from the request body and land in a file served as
    // image/svg+xml from the API origin, so they must be XML-escaped.
    const safeBuildingName = escapeXml(buildingName);
    const safeTitle = escapeXml(title);

    // Create basic SVG structure
    const svgContent = `
<svg xmlns="http://www.w3.org/2000/svg" 
     width="${width}" 
     height="${height}" 
     viewBox="0 0 ${width} ${height}">
  <!-- Background -->
  <rect width="100%" height="100%" fill="#f8f9fa" stroke="#dee2e6" stroke-width="2"/>
  
  <!-- Building Title -->
  <text x="${width/2}" y="40" text-anchor="middle" font-family="Arial, sans-serif" 
        font-size="24" font-weight="bold" fill="#212529">
    ${safeBuildingName}
  </text>

  <!-- Floor Title -->
  <text x="${width/2}" y="70" text-anchor="middle" font-family="Arial, sans-serif"
        font-size="18" fill="#6c757d">
    ${safeTitle}
  </text>
  
  <!-- Grid lines for reference -->
  <g stroke="#e9ecef" stroke-width="1">
    ${Array.from({length: 10}, (_, i) => 
      `<line x1="${(i + 1) * width/11}" y1="100" x2="${(i + 1) * width/11}" y2="${height - 50}"/>`
    ).join('\n    ')}
    ${Array.from({length: 8}, (_, i) => 
      `<line x1="50" y1="${100 + i * (height - 150)/8}" x2="${width - 50}" y2="${100 + i * (height - 150)/8}"/>`
    ).join('\n    ')}
  </g>
  
  <!-- Legend -->
  <g transform="translate(50, ${height - 40})">
    <rect x="0" y="0" width="15" height="15" fill="#28a745" rx="2"/>
    <text x="20" y="12" font-family="Arial, sans-serif" font-size="12" fill="#495057">Emergency Exit</text>
    
    <rect x="120" y="0" width="15" height="15" fill="#007bff" rx="2"/>
    <text x="140" y="12" font-family="Arial, sans-serif" font-size="12" fill="#495057">Stairs/Elevator</text>
    
    <rect x="260" y="0" width="15" height="15" fill="#ffc107" rx="2"/>
    <text x="280" y="12" font-family="Arial, sans-serif" font-size="12" fill="#495057">Path Point</text>
  </g>
  
  <!-- Metadata -->
  <metadata>
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
             xmlns:dc="http://purl.org/dc/elements/1.1/">
      <rdf:Description about="">
        <dc:title>${safeTitle}</dc:title>
        <dc:description>Generated floor map for ${safeBuildingName}</dc:description>
        <dc:date>${new Date().toISOString()}</dc:date>
        <dc:format>image/svg+xml</dc:format>
        <dc:dimensions>${width}x${height}</dc:dimensions>
      </rdf:Description>
    </rdf:RDF>
  </metadata>
</svg>`.trim();

    // Save SVG file
    fs.writeFileSync(svgPath, svgContent, 'utf8');

    return {
      success: true,
      svgPath,
      svgFilename,
      svgContent,
      dimensions: { width, height },
      fileSize: fs.statSync(svgPath).size
    };

  } catch (error) {
    console.error('Error creating basic SVG:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

/**
 * Process multiple image uploads
 * @param {Array} files - Array of uploaded file objects
 * @param {Object} options - Processing options
 * @returns {Promise<Array>} - Array of processing results
 */
export const processMultipleImages = async (files, options = {}) => {
  const results = [];
  
  for (const file of files) {
    try {
      const result = await convertImageToSVG(file.path, {
        filename: file.originalname.replace(/\.[^/.]+$/, ''),
        ...options
      });
      results.push(result);
    } catch (error) {
      results.push({
        success: false,
        filename: file.originalname,
        error: error.message
      });
    }
  }
  
  return results;
};
