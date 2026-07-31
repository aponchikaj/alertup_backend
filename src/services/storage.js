import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomBytes } from 'node:crypto';
import config from '../config/index.js';

// S3-backed asset storage, replacing Cloudinary. Maps, QR images and SVGs are
// public by bucket policy on these prefixes — scan pages are anonymous and
// emergency-critical, so no expiring presigned URLs.

const ALLOWED_PREFIXES = ['buildings/', 'conversions/'];

let client = null;
function s3() {
  if (!client) {
    client = new S3Client({
      region: config.aws.region,
      credentials:
        config.aws.accessKeyId && config.aws.secretAccessKey
          ? {
              accessKeyId: config.aws.accessKeyId,
              secretAccessKey: config.aws.secretAccessKey,
            }
          : undefined,
    });
  }
  return client;
}

export function publicUrl(key) {
  if (config.aws.s3PublicBaseUrl) {
    return `${config.aws.s3PublicBaseUrl.replace(/\/+$/, '')}/${key}`;
  }
  return `https://${config.aws.s3Bucket}.s3.${config.aws.region}.amazonaws.com/${key}`;
}

const CONTENT_TYPES = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

export function contentTypeFor(filenameOrExt) {
  const ext = String(filenameOrExt).toLowerCase().split('.').pop();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

/**
 * @param {{key: string, buffer: Buffer, contentType: string, cacheControl?: string}} params
 * @returns {Promise<string>} public URL
 */
export async function uploadBuffer({ key, buffer, contentType, cacheControl }) {
  if (!ALLOWED_PREFIXES.some((p) => key.startsWith(p))) {
    throw new Error(`Refusing to upload outside known prefixes: ${key}`);
  }
  // Test guard: the jest setup blanks AWS credentials so no test can ever hit
  // a real bucket. Return a deterministic fake URL instead of calling S3 —
  // deleteByUrl treats this host as foreign and skips it, so cleanup paths
  // stay no-ops too.
  if (process.env.NODE_ENV === 'test' && !process.env.AWS_ACCESS_KEY_ID) {
    return `https://test-assets.local/${key}`;
  }
  await s3().send(
    new PutObjectCommand({
      Bucket: config.aws.s3Bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      // Keys embed timestamps/random suffixes, so long-lived caching is safe.
      CacheControl: cacheControl || 'public, max-age=31536000, immutable',
    })
  );
  return publicUrl(key);
}

/** Key builders keep the bucket layout in one place. */
export const keys = {
  floorMap: (buildingId, floorId, ext) =>
    `buildings/${buildingId}/floors/${floorId}/map-${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`,
  nodeQr: (buildingId, nodeId, ext) => `buildings/${buildingId}/qr/${nodeId}.${ext}`,
  floorQr: (buildingId, floorId) => `buildings/${buildingId}/qr/floor-${floorId}.png`,
  conversion: (ext) =>
    `conversions/${Date.now()}-${randomBytes(6).toString('hex')}.${ext}`,
};

/**
 * Delete by public URL. Refuses URLs outside this bucket or outside the known
 * prefixes — the tenant-safety guard the Cloudinary service had.
 * Non-S3 URLs (legacy Cloudinary) are ignored so mixed-era rows delete safely.
 * @returns {Promise<'deleted'|'skipped'>}
 */
export async function deleteByUrl(url) {
  const key = keyFromUrl(url);
  if (!key) return 'skipped';
  if (!ALLOWED_PREFIXES.some((p) => key.startsWith(p))) {
    throw new Error(`Refusing to delete outside known prefixes: ${key}`);
  }
  await s3().send(
    new DeleteObjectCommand({ Bucket: config.aws.s3Bucket, Key: key })
  );
  return 'deleted';
}

export function keyFromUrl(url) {
  try {
    const u = new URL(url);
    const bucketHost = `${config.aws.s3Bucket}.s3.${config.aws.region}.amazonaws.com`;
    if (config.aws.s3PublicBaseUrl) {
      const base = new URL(config.aws.s3PublicBaseUrl);
      if (u.hostname === base.hostname) {
        return decodeURIComponent(u.pathname.replace(/^\/+/, ''));
      }
    }
    if (u.hostname === bucketHost) {
      return decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    }
    return null; // foreign URL (e.g. legacy Cloudinary) — not ours to delete
  } catch {
    return null;
  }
}
