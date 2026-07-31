import QRCode from 'qrcode';
import { uploadBuffer, deleteByUrl, keys, keyFromUrl } from './storage.js';

/**
 * QR code generation. Images render in memory and upload to S3 — nothing is
 * written to local disk (Render's filesystem is ephemeral).
 *
 * Every stored QR lives under `buildings/{buildingId}/qr/`. Deletion is scoped
 * to that namespace: without the guard, a caller could hand in the URL of any
 * asset — including another tenant's floor map — and have it deleted.
 */

const QR_KEY_NAMESPACE = /^buildings\/[^/]+\/qr\//;

const DEFAULTS = {
  size: 300,
  margin: 1,
  color: { dark: '#000000', light: '#FFFFFF' },
};

const renderOptions = (options = {}) => ({
  errorCorrectionLevel: 'H',
  width: options.size ?? DEFAULTS.size,
  margin: options.margin ?? DEFAULTS.margin,
  color: { ...DEFAULTS.color, ...(options.color || {}) },
});

const dimensionsOf = (options) => {
  const size = options.size ?? DEFAULTS.size;
  return { width: size, height: size };
};

/**
 * Render a QR code as PNG and store it.
 * @param {string} data payload encoded in the code
 * @param {object} options rendering options; `key` sets the storage key
 */
export const generateQRCodeFile = async (data, options = {}) => {
  try {
    const buffer = await QRCode.toBuffer(data, {
      ...renderOptions(options),
      type: 'png',
      quality: 0.92,
    });

    const key = options.key || keys.conversion('png');
    const url = await uploadBuffer({ key, buffer, contentType: 'image/png' });

    return {
      success: true,
      url,
      publicUrl: url,
      filename: key.split('/').pop(),
      size: buffer.length,
      dimensions: dimensionsOf(options),
    };
  } catch (error) {
    console.error('Error generating QR code file:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Render a QR code as SVG and store it. The markup is returned too, so a
 * caller can inline it without a network round-trip.
 */
export const generateQRCodeSVGFile = async (data, options = {}) => {
  try {
    const svgContent = await QRCode.toString(data, {
      ...renderOptions(options),
      type: 'svg',
    });

    const key = options.key || keys.conversion('svg');
    const url = await uploadBuffer({
      key,
      buffer: Buffer.from(svgContent, 'utf8'),
      contentType: 'image/svg+xml',
    });

    return {
      success: true,
      svgContent,
      url,
      publicUrl: url,
      filename: key.split('/').pop(),
      dimensions: dimensionsOf(options),
    };
  } catch (error) {
    console.error('Error generating QR code SVG file:', error);
    return { success: false, error: error.message };
  }
};

/** Render QR markup without storing anything. */
export const generateQRCodeSVG = async (data, options = {}) => {
  try {
    const svgContent = await QRCode.toString(data, {
      ...renderOptions(options),
      type: 'svg',
    });
    return { success: true, svgContent, dimensions: dimensionsOf(options) };
  } catch (error) {
    console.error('Error generating QR code SVG:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Render a QR code as a data URL. Floor-level codes are stored inline on the
 * Floor row rather than as separate objects.
 */
export const generateQRCodeDataUrl = async (data, options = {}) => {
  try {
    const dataUrl = await QRCode.toDataURL(data, renderOptions(options));
    return { success: true, dataUrl };
  } catch (error) {
    console.error('Error generating QR data URL:', error);
    return { success: false, error: error.message };
  }
};

/** Delete a stored QR asset, scoped to the QR key namespace. */
export const deleteQRCodeFile = async (url) => {
  const key = keyFromUrl(url);
  if (!key) {
    return { success: false, message: 'Not a managed asset URL' };
  }
  if (!QR_KEY_NAMESPACE.test(key)) {
    return { success: false, message: 'Not a QR code asset' };
  }
  try {
    await deleteByUrl(url);
    return { success: true, message: 'QR code deleted successfully' };
  } catch (error) {
    console.error('Error deleting QR code:', error);
    return { success: false, message: error.message };
  }
};
