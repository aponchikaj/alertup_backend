import path from 'path';
import { uploadBuffer, keys } from './storage.js';

/**
 * Floor-map SVG generation.
 *
 * Everything works on buffers and uploads to S3 — nothing touches local disk.
 * Render's filesystem is ephemeral, so the previous write-to-uploads/ approach
 * produced files that vanished on the next deploy.
 */

/** Strip a client-supplied name down to safe characters. */
export const sanitizeBaseName = (name) => {
  const base = path.basename(String(name ?? ''));
  return base.replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 64);
};

export const escapeXml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** Remove comments and collapse whitespace. */
const optimizeSVG = (svgContent) =>
  svgContent
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();

/**
 * Wrap an uploaded raster image in an SVG floor map and store it.
 *
 * The image is embedded as a data URI rather than linked: the source upload is
 * never persisted, so a `/uploads/...` reference would always resolve to a
 * missing file and every converted map would render as an empty rectangle.
 *
 * @param {Buffer} imageBuffer raw bytes of the uploaded image
 * @param {object} options
 *   - originalName: the client's filename (used for the mime type + metadata)
 *   - mimeType: overrides the extension-derived type
 *   - optimize: collapse whitespace (default true)
 */
export const convertImageToSVG = async (imageBuffer, options = {}) => {
  try {
    const { originalName = 'upload.png', mimeType, optimize = true } = options;

    if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
      return { success: false, error: 'No image data provided' };
    }

    const imageFilename = path.basename(originalName);
    const imageExt = path.extname(imageFilename).toLowerCase();
    const resolvedMime = mimeType || MIME_BY_EXT[imageExt] || 'image/png';

    // Raster dimensions are not parsed (no image library in the dependency
    // set); these defaults match the editor's model space closely enough that
    // preserveAspectRatio handles the rest.
    const width = ['.png', '.jpg', '.jpeg'].includes(imageExt) ? 1200 : 1000;
    const height = ['.png', '.jpg', '.jpeg'].includes(imageExt) ? 900 : 800;

    const imageUrl = `data:${resolvedMime};base64,${imageBuffer.toString('base64')}`;

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

  <rect width="100%" height="100%" fill="url(#floor-pattern)" stroke="#333" stroke-width="2"/>

  <g stroke="#ffffff20" stroke-width="0.5" fill="none">
    ${Array.from({ length: 20 }, (_, i) =>
      `<line x1="${((i + 1) * width) / 21}" y1="0" x2="${((i + 1) * width) / 21}" y2="${height}"/>`
    ).join('\n    ')}
    ${Array.from({ length: 15 }, (_, i) =>
      `<line x1="0" y1="${((i + 1) * height) / 16}" x2="${width}" y2="${((i + 1) * height) / 16}"/>`
    ).join('\n    ')}
  </g>

  <metadata>
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
             xmlns:dc="http://purl.org/dc/elements/1.1/">
      <rdf:Description about="">
        <dc:title>Converted Floor Map</dc:title>
        <dc:description>Floor map converted from ${escapeXml(imageExt)} for AlertUp emergency routing</dc:description>
        <dc:date>${new Date().toISOString()}</dc:date>
        <dc:format>image/svg+xml</dc:format>
        <dc:source>${escapeXml(imageFilename)}</dc:source>
        <dc:dimensions>${width}x${height}</dc:dimensions>
      </rdf:Description>
    </rdf:RDF>
  </metadata>
</svg>`.trim();

    const finalSvgContent = optimize ? optimizeSVG(svgContent) : svgContent;
    const buffer = Buffer.from(finalSvgContent, 'utf8');
    const key = keys.conversion('svg');
    const url = await uploadBuffer({ key, buffer, contentType: 'image/svg+xml' });

    return {
      success: true,
      svgPath: url,
      svgUrl: url,
      svgFilename: key.split('/').pop(),
      svgContent: finalSvgContent,
      originalFormat: imageExt.replace('.', ''),
      dimensions: { width, height },
      fileSize: buffer.length,
    };
  } catch (error) {
    console.error('Error converting image to SVG:', error);
    return { success: false, error: error.message };
  }
};

/** Generate an empty floor map from scratch and store it. */
export const createBasicSVG = async (options = {}) => {
  try {
    const {
      width = 1000,
      height = 800,
      title = 'Floor Map',
      buildingName = 'Building',
    } = options;

    // These come from the request body and land in a document served as
    // image/svg+xml, so they must be XML-escaped.
    const safeBuildingName = escapeXml(buildingName);
    const safeTitle = escapeXml(title);

    const svgContent = `
<svg xmlns="http://www.w3.org/2000/svg"
     width="${width}"
     height="${height}"
     viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#f8f9fa" stroke="#dee2e6" stroke-width="2"/>

  <text x="${width / 2}" y="40" text-anchor="middle" font-family="Arial, sans-serif"
        font-size="24" font-weight="bold" fill="#212529">
    ${safeBuildingName}
  </text>

  <text x="${width / 2}" y="70" text-anchor="middle" font-family="Arial, sans-serif"
        font-size="18" fill="#6c757d">
    ${safeTitle}
  </text>

  <g stroke="#e9ecef" stroke-width="1">
    ${Array.from({ length: 10 }, (_, i) =>
      `<line x1="${((i + 1) * width) / 11}" y1="100" x2="${((i + 1) * width) / 11}" y2="${height - 50}"/>`
    ).join('\n    ')}
    ${Array.from({ length: 8 }, (_, i) =>
      `<line x1="50" y1="${100 + (i * (height - 150)) / 8}" x2="${width - 50}" y2="${100 + (i * (height - 150)) / 8}"/>`
    ).join('\n    ')}
  </g>

  <g transform="translate(50, ${height - 40})">
    <rect x="0" y="0" width="15" height="15" fill="#28a745" rx="2"/>
    <text x="20" y="12" font-family="Arial, sans-serif" font-size="12" fill="#495057">Emergency Exit</text>

    <rect x="120" y="0" width="15" height="15" fill="#007bff" rx="2"/>
    <text x="140" y="12" font-family="Arial, sans-serif" font-size="12" fill="#495057">Stairs/Elevator</text>

    <rect x="260" y="0" width="15" height="15" fill="#ffc107" rx="2"/>
    <text x="280" y="12" font-family="Arial, sans-serif" font-size="12" fill="#495057">Path Point</text>
  </g>

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

    const buffer = Buffer.from(svgContent, 'utf8');
    const key = keys.conversion('svg');
    const url = await uploadBuffer({ key, buffer, contentType: 'image/svg+xml' });

    return {
      success: true,
      svgPath: url,
      svgUrl: url,
      svgFilename: key.split('/').pop(),
      svgContent,
      dimensions: { width, height },
      fileSize: buffer.length,
    };
  } catch (error) {
    console.error('Error creating basic SVG:', error);
    return { success: false, error: error.message };
  }
};

/** Convert a batch of uploaded images (multer memory storage entries). */
export const processMultipleImages = async (files, options = {}) => {
  const results = [];

  for (const file of files) {
    try {
      const result = await convertImageToSVG(file.buffer, {
        originalName: file.originalname,
        mimeType: file.mimetype,
        ...options,
      });
      results.push({ ...result, originalName: file.originalname });
    } catch (error) {
      results.push({
        success: false,
        filename: file.originalname,
        error: error.message,
      });
    }
  }

  return results;
};
