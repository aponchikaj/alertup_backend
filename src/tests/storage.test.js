import { jest } from '@jest/globals';

/* FX-027 — unit coverage for src/services/storage.js.

   config/index.js snapshots process.env at import, so each case sets the
   STORAGE_* variables it needs, resets the module registry and re-imports
   storage.js. The S3 client is mocked: nothing here can reach a bucket, and
   the mock records every command so the tests can assert what WOULD be sent. */

const sent = [];
jest.unstable_mockModule('@aws-sdk/client-s3', () => ({
  S3Client: class {
    constructor(opts) {
      this.opts = opts;
    }
    send(cmd) {
      sent.push(cmd);
      return Promise.resolve({});
    }
  },
  PutObjectCommand: class {
    constructor(input) {
      this.kind = 'put';
      this.input = input;
    }
  },
  DeleteObjectCommand: class {
    constructor(input) {
      this.kind = 'delete';
      this.input = input;
    }
  },
}));

const VARS = [
  'STORAGE_ENDPOINT', 'S3_ENDPOINT', 'STORAGE_REGION', 'AWS_REGION',
  'STORAGE_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY',
  'STORAGE_BUCKET', 'S3_BUCKET', 'STORAGE_PUBLIC_BASE_URL', 'S3_PUBLIC_BASE_URL', 'STORAGE_LEGACY_HOSTS',
];
const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));

afterAll(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  sent.length = 0;
});

/** Fresh storage module under the given env. Unlisted vars are blanked
 *  (not deleted — a deleted var would be refilled from .env by dotenv). */
const load = async (env = {}) => {
  for (const k of VARS) process.env[k] = '';
  Object.assign(process.env, { STORAGE_BUCKET: 'bkt', STORAGE_REGION: 'eu-central-1', ...env });
  jest.resetModules();
  return import('../services/storage.js');
};

const S3_HOST = 'bkt.s3.eu-central-1.amazonaws.com';

describe('publicUrl', () => {
  test('uses STORAGE_PUBLIC_BASE_URL, trimming trailing slashes', async () => {
    const { publicUrl } = await load({ STORAGE_PUBLIC_BASE_URL: 'https://assets.example.com//' });
    expect(publicUrl('buildings/b1/x.png')).toBe('https://assets.example.com/buildings/b1/x.png');
  });

  test('falls back to the virtual-hosted S3 URL on AWS', async () => {
    const { publicUrl } = await load();
    expect(publicUrl('buildings/b1/x.png')).toBe(`https://${S3_HOST}/buildings/b1/x.png`);
  });

  test('throws on R2 (endpoint set) without a public base', async () => {
    const { publicUrl } = await load({ STORAGE_ENDPOINT: 'https://acct.r2.cloudflarestorage.com' });
    expect(() => publicUrl('buildings/b1/x.png')).toThrow(/STORAGE_PUBLIC_BASE_URL is required/);
  });
});

test('contentTypeFor maps known extensions and defaults to octet-stream', async () => {
  const { contentTypeFor } = await load();
  expect(contentTypeFor('a/b/map.PNG')).toBe('image/png');
  expect(contentTypeFor('jpeg')).toBe('image/jpeg');
  expect(contentTypeFor('x.svg')).toBe('image/svg+xml');
  expect(contentTypeFor('x.webp')).toBe('image/webp');
  expect(contentTypeFor('x.exe')).toBe('application/octet-stream');
});

describe('keys', () => {
  test('every builder lands under an allowed, building-scoped prefix', async () => {
    const { keys, assertKeyInBuilding } = await load();
    expect(keys.floorMap('b1', 'f1', 'png')).toMatch(/^buildings\/b1\/floors\/f1\/map-\d+-[0-9a-f]{8}\.png$/);
    expect(keys.shopLogo('b1', 'webp')).toMatch(/^buildings\/b1\/logos\/\d+-[0-9a-f]{8}\.webp$/);
    expect(keys.nodeQr('b1', 'n1', 'svg', 'https://x/scan/b1/1/n1')).toMatch(/^buildings\/b1\/qr\/n1-[0-9a-f]{10}\.svg$/);
    expect(keys.floorQr('b1', 'f1')).toBe('buildings/b1/qr/floor-f1.png');
    expect(keys.conversion('png')).toMatch(/^conversions\/\d+-[0-9a-f]{12}\.png$/);
    for (const k of [keys.floorMap('b1', 'f', 'png'), keys.shopLogo('b1', 'png'), keys.nodeQr('b1', 'n', 'png'), keys.floorQr('b1', 'f')]) {
      expect(() => assertKeyInBuilding(k, 'b1')).not.toThrow();
    }
  });

  test('random suffixes keep two map keys for the same floor distinct', async () => {
    const { keys } = await load();
    expect(keys.floorMap('b1', 'f1', 'png')).not.toBe(keys.floorMap('b1', 'f1', 'png'));
  });
});

describe('assertKeyInBuilding (FX-014 edge cases)', () => {
  test.each([
    ['the bare building folder', 'buildings/b1'],
    ['a "." segment', 'buildings/b1/./x.png'],
    ['an empty segment', 'buildings/b1//x.png'],
    ['a non-buildings prefix', 'conversions/b1/x.png'],
  ])('refuses %s', async (_label, key) => {
    const { assertKeyInBuilding } = await load();
    expect(() => assertKeyInBuilding(key, 'b1')).toThrow();
  });
});

describe('keyFromUrl', () => {
  test('recognises the public base host, the raw S3 host and legacy hosts', async () => {
    const { keyFromUrl } = await load({
      STORAGE_PUBLIC_BASE_URL: 'https://assets.example.com',
      STORAGE_LEGACY_HOSTS: 'https://old-cdn.example.com/path, legacy.example.org',
    });
    expect(keyFromUrl('https://assets.example.com/buildings/b1/x.png')).toBe('buildings/b1/x.png');
    expect(keyFromUrl(`https://${S3_HOST}/buildings/b1/x.png`)).toBe('buildings/b1/x.png');
    expect(keyFromUrl('https://old-cdn.example.com/buildings/b1/x.png')).toBe('buildings/b1/x.png');
    expect(keyFromUrl('https://legacy.example.org/conversions/y.svg')).toBe('conversions/y.svg');
  });

  test('percent-decodes the key', async () => {
    const { keyFromUrl } = await load();
    expect(keyFromUrl(`https://${S3_HOST}/buildings/b1/my%20map.png`)).toBe('buildings/b1/my map.png');
  });

  test('foreign hosts and garbage return null', async () => {
    const { keyFromUrl } = await load();
    expect(keyFromUrl('https://res.cloudinary.com/demo/x.png')).toBeNull();
    expect(keyFromUrl('https://test-assets.local/buildings/b1/x.png')).toBeNull();
    expect(keyFromUrl('not a url')).toBeNull();
    expect(keyFromUrl(undefined)).toBeNull();
  });

  test('on R2 without a public base only the raw S3 and legacy hosts are ours', async () => {
    const { keyFromUrl } = await load({ STORAGE_ENDPOINT: 'https://acct.r2.cloudflarestorage.com' });
    expect(keyFromUrl('https://acct.r2.cloudflarestorage.com/bkt/buildings/b1/x.png')).toBeNull();
    expect(keyFromUrl(`https://${S3_HOST}/buildings/b1/x.png`)).toBe('buildings/b1/x.png');
  });
});

describe('uploadBuffer', () => {
  test('refuses keys outside the known prefixes', async () => {
    const { uploadBuffer } = await load();
    await expect(uploadBuffer({ key: 'secrets/x.png', buffer: Buffer.from('x'), contentType: 'image/png' })).rejects.toThrow(
      /outside known prefixes/
    );
    expect(sent).toHaveLength(0);
  });

  test('without credentials in tests it returns a fake URL and never calls S3', async () => {
    const { uploadBuffer } = await load();
    const url = await uploadBuffer({ key: 'buildings/b1/x.png', buffer: Buffer.from('x'), contentType: 'image/png' });
    expect(url).toBe('https://test-assets.local/buildings/b1/x.png');
    expect(sent).toHaveLength(0);
  });

  test('with credentials it puts the object with immutable caching and returns the public URL', async () => {
    const { uploadBuffer } = await load({
      STORAGE_ACCESS_KEY_ID: 'AKIA-TEST',
      STORAGE_SECRET_ACCESS_KEY: 'shh',
      STORAGE_PUBLIC_BASE_URL: 'https://assets.example.com',
    });
    const url = await uploadBuffer({ key: 'buildings/b1/x.png', buffer: Buffer.from('x'), contentType: 'image/png' });
    expect(url).toBe('https://assets.example.com/buildings/b1/x.png');
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe('put');
    expect(sent[0].input).toMatchObject({
      Bucket: 'bkt',
      Key: 'buildings/b1/x.png',
      ContentType: 'image/png',
      CacheControl: 'public, max-age=31536000, immutable',
    });

    await uploadBuffer({ key: 'conversions/y.svg', buffer: Buffer.from('y'), contentType: 'image/svg+xml', cacheControl: 'no-store' });
    expect(sent[1].input.CacheControl).toBe('no-store');
  });
});

describe('deleteByUrl', () => {
  test('a foreign URL is skipped without touching S3', async () => {
    const { deleteByUrl } = await load();
    await expect(deleteByUrl('https://res.cloudinary.com/x.png', { buildingId: 'b1' })).resolves.toBe('skipped');
    expect(sent).toHaveLength(0);
  });

  test("deletes this building's asset", async () => {
    const { deleteByUrl } = await load();
    await expect(deleteByUrl(`https://${S3_HOST}/buildings/b1/floors/f1/map.png`, { buildingId: 'b1' })).resolves.toBe('deleted');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'delete', input: { Bucket: 'bkt', Key: 'buildings/b1/floors/f1/map.png' } });
  });

  test('conversions need no building scope', async () => {
    const { deleteByUrl } = await load();
    await expect(deleteByUrl(`https://${S3_HOST}/conversions/x.svg`)).resolves.toBe('deleted');
  });

  test.each([
    ['another building', `/buildings/b2/floors/f1/map.png`, { buildingId: 'b1' }],
    ['no building scope', `/buildings/b1/floors/f1/map.png`, {}],
    ['an unknown prefix in our bucket', `/private/dump.sql`, { buildingId: 'b1' }],
    ['a prefix trick (b1 vs b10)', `/buildings/b10/x.png`, { buildingId: 'b1' }],
  ])('refuses %s and sends nothing', async (_label, path, scope) => {
    const { deleteByUrl } = await load();
    await expect(deleteByUrl(`https://${S3_HOST}${path}`, scope)).rejects.toThrow(/Refusing/);
    expect(sent).toHaveLength(0);
  });
});

test('node QR keys change with what the code encodes, so the 1-year immutable cache stays correct (BE-36)', async () => {
  const { keys } = await load();
  const ground = keys.nodeQr('b1', 'n1', 'png', 'https://x/scan/b1/1/n1');
  expect(keys.nodeQr('b1', 'n1', 'png', 'https://x/scan/b1/1/n1')).toBe(ground);
  // The same sticker after its floor was renumbered encodes a different URL.
  expect(keys.nodeQr('b1', 'n1', 'png', 'https://x/scan/b1/2/n1')).not.toBe(ground);
});
