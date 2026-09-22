import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomBytes } from 'node:crypto';
import config from '../config/index.js';

// S3-compatible asset storage. Maps, QR images and SVGs are public on these
// prefixes — scan pages are anonymous and emergency-critical, so no expiring
// presigned URLs.
//
// Works against AWS S3 or Cloudflare R2 unchanged; `STORAGE_ENDPOINT` is what
// switches them. On R2 the bucket is private and served through a custom
// domain, so STORAGE_PUBLIC_BASE_URL is mandatory there (see publicUrl).

const ALLOWED_PREFIXES = ['buildings/', 'conversions/'];

let client = null;
function s3() {
  if (!client) {
    client = new S3Client({
      region: config.storage.region,
      // Unset for AWS; for R2 this is https://<account>.r2.cloudflarestorage.com.
      ...(config.storage.endpoint ? { endpoint: config.storage.endpoint } : {}),
      credentials:
        config.storage.accessKeyId && config.storage.secretAccessKey
          ? {
              accessKeyId: config.storage.accessKeyId,
              secretAccessKey: config.storage.secretAccessKey,
            }
          : undefined,
    });
  }
  return client;
}

/** Host that `publicUrl` builds from, or null when no base is configured. */
function publicHost() {
  if (config.storage.publicBaseUrl) {
    try {
      return new URL(config.storage.publicBaseUrl).hostname;
    } catch {
      return null;
    }
  }
  if (config.storage.endpoint) return null; // R2 has no predictable public host
  return `${config.storage.bucket}.s3.${config.storage.region}.amazonaws.com`;
}

export function publicUrl(key) {
  if (config.storage.publicBaseUrl) {
    return `${config.storage.publicBaseUrl.replace(/\/+$/, '')}/${key}`;
  }
  // R2 buckets are private by default and the r2.dev subdomain is rate-limited
  // and unsupported for production traffic. Failing loudly here beats writing
  // a row whose URL 404s for every visitor who scans that QR code.
  if (config.storage.endpoint) {
    throw new Error(
      'STORAGE_PUBLIC_BASE_URL is required when STORAGE_ENDPOINT is set — ' +
        'bind a custom domain to the R2 bucket and point this at it.'
    );
  }
  return `https://${config.storage.bucket}.s3.${config.storage.region}.amazonaws.com/${key}`;
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
  if (process.env.NODE_ENV === 'test' && !config.storage.accessKeyId) {
    return `https://test-assets.local/${key}`;
  }
  await s3().send(
    new PutObjectCommand({
      Bucket: config.storage.bucket,
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
  shopLogo: (buildingId, ext) =>
    `buildings/${buildingId}/logos/${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`,
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
    new DeleteObjectCommand({ Bucket: config.storage.bucket, Key: key })
  );
  return 'deleted';
}

export function keyFromUrl(url) {
  try {
    const u = new URL(url);

    // Every host that has ever served our assets. Rows outlive migrations, so
    // a URL written in the S3 era must still be recognised as ours after the
    // move to R2 — otherwise deleting a building silently orphans its files.
    const ours = new Set(
      [
        publicHost(),
        // The raw S3 host stays claimable even after STORAGE_PUBLIC_BASE_URL
        // starts pointing at a CDN or R2 custom domain.
        `${config.storage.bucket}.s3.${config.storage.region}.amazonaws.com`,
        ...config.storage.legacyHosts,
      ].filter(Boolean)
    );

    if (ours.has(u.hostname)) {
      return decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    }
    return null; // foreign URL (e.g. legacy Cloudinary) — not ours to delete
  } catch {
    return null;
  }
}
