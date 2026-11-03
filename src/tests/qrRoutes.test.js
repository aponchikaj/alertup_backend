import { jest } from '@jest/globals';

/* FX-027 — integration coverage for src/routes/qr/qr.js.
   Uploads already short-circuit in tests (storage.uploadBuffer returns a fake
   test-assets.local URL when no credentials are set). Deletes do not, so the
   S3 client is mocked: a delete that passes every guard must reach `send`,
   and one that fails a guard must never get there. */

const sent = [];
jest.unstable_mockModule('@aws-sdk/client-s3', () => ({
  S3Client: class {
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

const { default: request } = await import('supertest');
const { default: app } = await import('../../server.js');
const { default: prisma } = await import('../db/prisma.js');
const { default: config } = await import('../config/index.js');
const { createUser, createOwnerWithBuilding, createFloor, createNode, addMember } = await import('./helpers.js');

beforeEach(() => {
  sent.length = 0;
});

// The raw S3 host is always recognised as ours by keyFromUrl.
const s3Url = (key) => `https://${config.storage.bucket}.s3.${config.storage.region}.amazonaws.com/${key}`;

const setup = async () => {
  const owner = await createOwnerWithBuilding();
  const floor = await createFloor(owner.building.id, { floorNumber: 0, name: 'Ground' });
  const node = await createNode(owner.building.id, floor.id);
  return { ...owner, floor, node };
};

describe('POST /api/qr/generate', () => {
  const generate = (cookie, body) => request(app).post('/api/qr/generate').set('Cookie', cookie).send(body);

  test('401 without a session', async () => {
    const res = await request(app).post('/api/qr/generate').send({});
    expect(res.status).toBe(401);
  });

  test('PNG on floor 0: stores under the building QR prefix and caches the slug on the node', async () => {
    const { cookie, building, node } = await setup();
    const res = await generate(cookie, { nodeId: node.id, buildingId: building.id, floorNumber: 0 });

    expect(res.status).toBe(200);
    const { data } = res.body;
    expect(data.format).toBe('png');
    expect(data.qrData).toMatch(new RegExp(`/scan/route/qr_${building.id}_0_${node.id}$`));
    // BE-36: the key carries a hash of the encoded URL.
    expect(data.url).toMatch(new RegExp(`^https://test-assets\\.local/buildings/${building.id}/qr/${node.id}-[0-9a-f]{10}\\.png$`));
    expect(data.filename).toBe(`${node.id}.png`);
    expect(data.dimensions).toEqual({ width: 300, height: 300 });
    expect(data.size).toBeGreaterThan(0);
    expect((await prisma.node.findUnique({ where: { id: node.id } })).qrSlug).toBe(`qr_${building.id}_0_${node.id}`);
  });

  test('SVG returns the inline markup', async () => {
    const { cookie, building, node } = await setup();
    const res = await generate(cookie, { nodeId: node.id, buildingId: building.id, floorNumber: '0', format: 'svg' });
    expect(res.status).toBe(200);
    expect(res.body.data.svgContent).toContain('<svg');
    expect(res.body.data.url).toMatch(/\.svg$/);
  });

  test.each([
    ['nodeId', { buildingId: 'B', floorNumber: 1 }],
    ['floorNumber', { nodeId: 'N', buildingId: 'B' }],
    ['floorNumber as empty string', { nodeId: 'N', buildingId: 'B', floorNumber: '' }],
  ])('400 when %s is missing', async (_label, partial) => {
    const { cookie, building, node } = await setup();
    const body = { ...partial, buildingId: building.id };
    if (partial.nodeId) body.nodeId = node.id;
    const res = await generate(cookie, body);
    expect(res.status).toBe(400);
  });

  test('400 for an unknown format', async () => {
    const { cookie, building, node } = await setup();
    const res = await generate(cookie, { nodeId: node.id, buildingId: building.id, floorNumber: 0, format: 'gif' });
    expect(res.status).toBe(400);
  });

  test('400 when the node is not on the claimed floor', async () => {
    const { cookie, building, node } = await setup();
    const res = await generate(cookie, { nodeId: node.id, buildingId: building.id, floorNumber: 3 });
    expect(res.status).toBe(400);
  });

  test("404 for a node from another building (no cross-tenant QR minting)", async () => {
    const { cookie, building } = await setup();
    const other = await setup();
    const res = await generate(cookie, { nodeId: other.node.id, buildingId: building.id, floorNumber: 0 });
    expect(res.status).toBe(404);
    expect((await prisma.node.findUnique({ where: { id: other.node.id } })).qrSlug).toBeNull();
  });

  test('403 for a stranger and for a member without CAN_EDIT_MAP; a Moderator may', async () => {
    const { building, node, roles } = await setup();
    const body = { nodeId: node.id, buildingId: building.id, floorNumber: 0 };

    const stranger = await createUser();
    expect((await generate(stranger.cookie, body)).status).toBe(403);

    const viewer = await createUser();
    await addMember(building.id, viewer.user.id, roles.Viewer.id);
    expect((await generate(viewer.cookie, body)).status).toBe(403);

    const moderator = await createUser();
    await addMember(building.id, moderator.user.id, roles.Moderator.id);
    expect((await generate(moderator.cookie, body)).status).toBe(200);
  });

  test('404 for an unknown building', async () => {
    const { cookie, node } = await setup();
    const res = await generate(cookie, { nodeId: node.id, buildingId: 'cxxxxxxxxxxxxxxxxxxxxxxxx', floorNumber: 0 });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/qr/:buildingId/:qrUrl', () => {
  const del = (cookie, buildingId, url) =>
    request(app).delete(`/api/qr/${buildingId}/${encodeURIComponent(url)}`).set('Cookie', cookie);

  test('401 without a session', async () => {
    const { building } = await setup();
    const res = await request(app).delete(`/api/qr/${building.id}/x`);
    expect(res.status).toBe(401);
  });

  test('deletes a QR under this building and clears a matching floor reference', async () => {
    const { cookie, building, floor } = await setup();
    const url = s3Url(`buildings/${building.id}/qr/floor-${floor.id}.png`);
    await prisma.floor.update({ where: { id: floor.id }, data: { qrCodeUrl: url } });

    const res = await del(cookie, building.id, url);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('QR code deleted successfully');
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe('delete');
    expect(sent[0].input.Key).toBe(`buildings/${building.id}/qr/floor-${floor.id}.png`);
    expect((await prisma.floor.findUnique({ where: { id: floor.id } })).qrCodeUrl).toBeNull();
  });

  test("403 for another building's QR, a non-QR asset, or a foreign host — nothing is deleted", async () => {
    const { cookie, building } = await setup();
    const other = await setup();
    for (const url of [
      s3Url(`buildings/${other.building.id}/qr/${other.node.id}.png`),
      s3Url(`buildings/${building.id}/floors/f1/map-1.png`),
      `https://evil.example.com/buildings/${building.id}/qr/x.png`,
    ]) {
      const res = await del(cookie, building.id, url);
      expect(res.status).toBe(403);
    }
    expect(sent).toHaveLength(0);
  });

  test('a path-traversal key inside the QR prefix is refused by the storage guard', async () => {
    const { cookie, building } = await setup();
    const other = await setup();
    const url = s3Url(`buildings/${building.id}/qr/../../${other.building.id}/qr/${other.node.id}.png`);
    const res = await del(cookie, building.id, url);
    // URL parsing normalises the `..` segments away, so the key lands outside
    // this building's prefix and the route refuses it up front.
    expect([403, 404]).toContain(res.status);
    expect(sent).toHaveLength(0);
  });

  test('403 for a member without CAN_EDIT_MAP', async () => {
    const { building, roles } = await setup();
    const viewer = await createUser();
    await addMember(building.id, viewer.user.id, roles.Viewer.id);
    const res = await del(viewer.cookie, building.id, s3Url(`buildings/${building.id}/qr/x.png`));
    expect(res.status).toBe(403);
    expect(sent).toHaveLength(0);
  });
});
