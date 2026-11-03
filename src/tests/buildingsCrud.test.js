import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import {
  createUser,
  createBuilding,
  createFloor,
  createNode,
  addMember,
  createOwnerWithBuilding,
} from './helpers.js';

/* FX-027 — integration coverage for src/routes/buildings/buildings.js.
   These routes keep the legacy `{Success, Message}` envelope, and most
   validation failures answer 200 + Success:false (the deployed frontend reads
   that shape), so the tests pin that contract rather than an HTTP status. */

const png = (name = 'map.png') => [Buffer.from('fake-png'), { filename: name, contentType: 'image/png' }];

const createViaApi = (cookie, buildingName, floorNames, files = 0) => {
  let req = request(app).post('/api/building/new').set('Cookie', cookie).field('buildingName', buildingName);
  for (const f of floorNames) req = req.field('floorNames', f);
  for (let i = 0; i < files; i++) req = req.attach('maps', ...png(`m${i}.png`));
  return req;
};

describe('POST /api/building/new', () => {
  test('401 without a session', async () => {
    const res = await request(app).post('/api/building/new').send({ buildingName: 'Tower One' });
    expect(res.status).toBe(401);
  });

  test('creates a building with system roles, floors, QR data URLs and uploaded maps', async () => {
    const { user, cookie } = await createUser();
    const res = await createViaApi(cookie, 'Tower One', ['Ground', 'First'], 1);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const id = res.body.buildingID;

    const building = await prisma.building.findUnique({
      where: { id },
      include: { floors: { orderBy: { floorNumber: 'asc' } }, roles: true },
    });
    expect(building.ownerId).toBe(user.id);
    expect(building.name).toBe('Tower One');
    expect(building.roles.length).toBeGreaterThan(0);
    expect(building.roles.every((r) => r.isSystem)).toBe(true);
    expect(building.floors.map((f) => [f.floorNumber, f.name])).toEqual([
      [1, 'Ground'],
      [2, 'First'],
    ]);
    expect(building.floors[0].qrCodeUrl).toMatch(/^data:image\/png;base64,/);
    // Storage is unconfigured in tests: uploadBuffer returns the fake host.
    expect(building.floors[0].mapImageUrl).toMatch(
      new RegExp(`^https://test-assets\\.local/buildings/${id}/floors/${building.floors[0].id}/map-`)
    );
    expect(building.floors[1].mapImageUrl).toBeNull();
  });

  test('a single floor name sent as a bare string is accepted', async () => {
    const { cookie } = await createUser();
    const res = await request(app)
      .post('/api/building/new')
      .set('Cookie', cookie)
      .send({ buildingName: 'Solo House', floorNames: 'Only' });
    expect(res.body.success).toBe(true);
  });

  test('an unverified account is refused', async () => {
    const { cookie } = await createUser({ verified: false });
    const res = await createViaApi(cookie, 'Tower One', ['Ground']);
    expect(res.body).toEqual({ success: false, message: 'Verify account first.' });
    expect(await prisma.building.count()).toBe(0);
  });

  test.each([
    ['missing name', { floorNames: ['A'] }, 'Invalid building name.'],
    ['non-string name', { buildingName: 42, floorNames: ['A'] }, 'Invalid building name.'],
    ['no floors', { buildingName: 'Tower One' }, 'Invalid floor names.'],
    ['blank floors only', { buildingName: 'Tower One', floorNames: ['  '] }, 'Invalid floor names.'],
    ['duplicate floors (case-insensitive)', { buildingName: 'Tower One', floorNames: ['A', 'a'] }, 'Floor names must be unique.'],
    ['name too short', { buildingName: 'abc', floorNames: ['A'] }, 'Building name must have from 4 to 40 characters.'],
    ['name too long', { buildingName: 'x'.repeat(41), floorNames: ['A'] }, 'Building name must have from 4 to 40 characters.'],
    ['profane name', { buildingName: 'shit tower', floorNames: ['A'] }, 'Building name contains bad words.'],
  ])('validation: %s', async (_label, body, message) => {
    const { cookie } = await createUser();
    const res = await request(app).post('/api/building/new').set('Cookie', cookie).send(body);
    expect(res.body).toEqual({ success: false, message: message });
    expect(await prisma.building.count()).toBe(0);
  });

  test('more map files than floors is refused', async () => {
    const { cookie } = await createUser();
    const res = await createViaApi(cookie, 'Tower One', ['Ground'], 2);
    expect(res.body).toEqual({ success: false, message: 'Too many map files uploaded.' });
  });

  test('a non-image upload is rejected by the multer filter', async () => {
    const { cookie } = await createUser();
    const res = await request(app)
      .post('/api/building/new')
      .set('Cookie', cookie)
      .field('buildingName', 'Tower One')
      .field('floorNames', 'Ground')
      .attach('maps', Buffer.from('<svg/>'), { filename: 'x.svg', contentType: 'image/svg+xml' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.building.count()).toBe(0);
  });

  test('FREE plan: second building is refused (plan cap)', async () => {
    const { user, cookie } = await createUser({ plan: 'FREE' });
    await createBuilding(user.id, { name: 'First One' });
    const res = await createViaApi(cookie, 'Second One', ['Ground']);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/up to 1 building\. Upgrade/);
  });

  test('STARTER plan: the cap message is pluralised and 3 buildings is the limit', async () => {
    const { user, cookie } = await createUser({ plan: 'STARTER' });
    for (const n of ['Bldg A1', 'Bldg A2', 'Bldg A3']) await createBuilding(user.id, { name: n });
    const res = await createViaApi(cookie, 'Bldg A4', ['Ground']);
    expect(res.body.message).toMatch(/up to 3 buildings\./);
  });

  test('FREE plan: more floors than the per-building cap is refused', async () => {
    const { cookie } = await createUser({ plan: 'FREE' });
    const res = await createViaApi(cookie, 'Tower One', ['A', 'B', 'C']);
    expect(res.body.message).toMatch(/up to 2 floors per building/);
    expect(await prisma.building.count()).toBe(0);
  });

  test('a duplicate name among the same owner’s buildings is refused', async () => {
    const { user, cookie } = await createUser({ plan: 'STARTER' });
    await createBuilding(user.id, { name: 'Tower One' });
    const res = await createViaApi(cookie, '  Tower One  ', ['Ground']);
    expect(res.body).toEqual({ success: false, message: 'Building name already exists in your buildings.' });
  });
});

// FX-052 / FX-027-1: the legacy owner update was removed. It matched floors by
// NAME (a rename deleted that floor's whole graph), was not transactional,
// and skipped the plan's floor cap. No frontend on stage or main called it;
// buildings are edited in the map editor.
describe('PUT /api/building/:id (removed)', () => {
  test('no longer exists', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const res = await request(app)
      .put(`/api/building/${building.id}`)
      .set('Cookie', cookie)
      .send({ buildingName: 'Renamed', floorNames: ['A', 'B', 'C', 'D'] });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/building/id/:buildingID (public)', () => {
  test('returns the legacy shape and a minimal owner — no email or phone', async () => {
    const { building, user } = await createOwnerWithBuilding();
    await createFloor(building.id, { floorNumber: 2, name: 'Second' });
    await createFloor(building.id, { floorNumber: 1, name: 'Ground' });

    const res = await request(app).get(`/api/building/id/${building.id}`);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      _id: building.id,
      buildingName: 'Test Building',
      owner: user.id,
      floors: 2,
      globalScans: [],
    });
    expect(res.body.data.maps.map((m) => m.floor)).toEqual(['Ground', 'Second']);
    expect(res.body.Owner).toEqual({ _id: user.id, displayName: expect.any(String), userType: 'INDIVIDUAL' });
    expect(JSON.stringify(res.body)).not.toContain(user.email);
  });

  test('invalid and unknown ids', async () => {
    const bad = await request(app).get('/api/building/id/nope');
    expect(bad.body).toEqual({ success: false, message: 'Invalid building ID.' });
    const missing = await request(app).get('/api/building/id/cxxxxxxxxxxxxxxxxxxxxxxxx');
    expect(missing.body).toEqual({ success: false, message: 'Building not found.' });
  });
});

describe('GET /api/building/my', () => {
  test('401 without a session', async () => {
    expect((await request(app).get('/api/building/my')).status).toBe(401);
  });

  test('lists owned buildings and, separately, memberships with role + permissions', async () => {
    const { cookie, user, building } = await createOwnerWithBuilding();
    const other = await createOwnerWithBuilding();
    const roleId = Object.values(other.roles)[0].id;
    await addMember(other.building.id, user.id, roleId);

    const res = await request(app).get('/api/building/my').set('Cookie', cookie);
    expect(res.body.success).toBe(true);
    expect(res.body.data.map((b) => b.id)).toEqual([building.id]);
    expect(res.body.memberBuildings).toHaveLength(1);
    expect(res.body.memberBuildings[0]).toMatchObject({
      id: other.building.id,
      role: Object.values(other.roles)[0].name,
      permissions: expect.any(Array),
    });
  });
});

describe('GET /api/building/scan/:id/:floor (legacy floor QR)', () => {
  test('400 for a malformed id, 404 for an unknown building', async () => {
    expect((await request(app).get('/api/building/scan/bad/1')).status).toBe(400);
    expect((await request(app).get('/api/building/scan/cxxxxxxxxxxxxxxxxxxxxxxxx/1')).status).toBe(404);
  });

  test('404 when the building has no floors', async () => {
    const { building } = await createOwnerWithBuilding();
    expect((await request(app).get(`/api/building/scan/${building.id}/1`)).status).toBe(404);
  });

  test('410 for a deactivated building — and it stays deactivated', async () => {
    const { building } = await createOwnerWithBuilding();
    await createFloor(building.id);
    await prisma.building.update({ where: { id: building.id }, data: { isDeactivated: true } });
    const res = await request(app).get(`/api/building/scan/${building.id}/1`);
    expect(res.status).toBe(410);
    expect((await prisma.building.findUnique({ where: { id: building.id } })).isDeactivated).toBe(true);
  });

  test('resolves by name, then number, then first floor; anonymous scans count', async () => {
    const { building } = await createOwnerWithBuilding();
    const ground = await createFloor(building.id, { floorNumber: 1, name: 'Ground' });
    const top = await createFloor(building.id, { floorNumber: 2, name: 'Top' });

    const byName = await request(app).get(`/api/building/scan/${building.id}/Top`);
    expect(byName.body.data).toMatchObject({ buildingName: 'Test Building', scannedCount: 1 });
    expect(byName.body.data.floorData.floor).toBe('Top');

    const byNumber = await request(app).get(`/api/building/scan/${building.id}/2`);
    expect(byNumber.body.data.scannedCount).toBe(2);

    const fallback = await request(app).get(`/api/building/scan/${building.id}/Nowhere`);
    expect(fallback.body.data.floorData.floor).toBe('Ground');

    expect((await prisma.floor.findUnique({ where: { id: top.id } })).scanCount).toBe(2);
    expect((await prisma.floor.findUnique({ where: { id: ground.id } })).scanCount).toBe(1);
  });

  test('owner and member views do not inflate the scan count (FX-022)', async () => {
    const { building, cookie, roles } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, { floorNumber: 1, name: 'Ground', scanCount: 3 });
    const member = await createUser();
    await addMember(building.id, member.user.id, Object.values(roles)[0].id);

    for (const c of [cookie, member.cookie]) {
      const res = await request(app).get(`/api/building/scan/${building.id}/Ground`).set('Cookie', c);
      expect(res.body.data.scannedCount).toBe(3);
    }
    expect((await prisma.floor.findUnique({ where: { id: floor.id } })).scanCount).toBe(3);
  });

  test('a signed-in visitor gets a scan event; during an emergency the scan is logged', async () => {
    const { building } = await createOwnerWithBuilding();
    await createFloor(building.id, { floorNumber: 1, name: 'Ground' });
    await prisma.building.update({ where: { id: building.id }, data: { emergencyMode: true } });
    const event = await prisma.emergencyEvent.create({ data: { buildingId: building.id } });
    const visitor = await createUser();

    const res = await request(app).get(`/api/building/scan/${building.id}/Ground`).set('Cookie', visitor.cookie);
    expect(res.status).toBe(200);
    expect(await prisma.scanEvent.count({ where: { userId: visitor.user.id, buildingId: building.id } })).toBe(1);
    expect(await prisma.log.count({ where: { buildingId: building.id, type: 'SCAN', isEmergency: true } })).toBe(1);
    expect((await prisma.emergencyEvent.findUnique({ where: { id: event.id } })).scanned).toBe(1);
  });

  test('an invalid session cookie does not break an anonymous scan', async () => {
    const { building } = await createOwnerWithBuilding();
    await createFloor(building.id);
    const res = await request(app).get(`/api/building/scan/${building.id}/1`).set('Cookie', ['userToken=garbage']);
    expect(res.status).toBe(200);
    expect(res.body.data.scannedCount).toBe(1);
    // FX-094: recorded, but not attributed to anyone.
    const events = await prisma.scanEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0].userId).toBeNull();
  });
});

describe('DELETE /api/building/delete/:buildingId', () => {
  test('401 / 403 for anonymous and non-owner callers', async () => {
    const { building } = await createOwnerWithBuilding();
    expect((await request(app).delete(`/api/building/delete/${building.id}`)).status).toBe(401);
    const stranger = await createUser();
    const res = await request(app).delete(`/api/building/delete/${building.id}`).set('Cookie', stranger.cookie);
    expect(res.status).toBe(403);
    expect(await prisma.building.count({ where: { id: building.id } })).toBe(1);
  });

  test('owner deletes the building; floors and nodes cascade and counts are reported', async () => {
    const { building, cookie } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, { mapImageUrl: 'https://test-assets.local/x.png' });
    await createNode(building.id, floor.id);
    await createNode(building.id, floor.id);

    const res = await request(app).delete(`/api/building/delete/${building.id}`).set('Cookie', cookie);
    expect(res.body).toMatchObject({ success: true, DeletedCounts: { nodes: 2, floors: 1 } });
    expect(await prisma.building.count()).toBe(0);
    expect(await prisma.node.count()).toBe(0);
  });
});

describe('DELETE /api/building/:buildingId/floor/:floorNumber', () => {
  test('400 for a non-positive floor number', async () => {
    const { building, cookie } = await createOwnerWithBuilding();
    for (const n of ['0', 'abc']) {
      const res = await request(app).delete(`/api/building/${building.id}/floor/${n}`).set('Cookie', cookie);
      expect(res.status).toBe(400);
    }
  });

  test('403 for a user without CAN_EDIT_MAP', async () => {
    const { building } = await createOwnerWithBuilding();
    const stranger = await createUser();
    const res = await request(app).delete(`/api/building/${building.id}/floor/1`).set('Cookie', stranger.cookie);
    expect(res.status).toBe(403);
  });

  test('deletes only that floor; other floors keep their numbers', async () => {
    const { building, cookie } = await createOwnerWithBuilding();
    const f1 = await createFloor(building.id, { floorNumber: 1 });
    await createNode(building.id, f1.id);
    await createFloor(building.id, { floorNumber: 2 });
    const f3 = await createFloor(building.id, { floorNumber: 3 });

    const res = await request(app).delete(`/api/building/${building.id}/floor/1`).set('Cookie', cookie);
    expect(res.body).toMatchObject({ success: true, DeletedCounts: { nodes: 1, floorMap: 1 } });
    expect((await prisma.floor.findUnique({ where: { id: f3.id } })).floorNumber).toBe(3);
  });

  test('a missing floor is a successful no-op', async () => {
    const { building, cookie } = await createOwnerWithBuilding();
    const res = await request(app).delete(`/api/building/${building.id}/floor/9`).set('Cookie', cookie);
    expect(res.body).toMatchObject({ success: true, DeletedCounts: { nodes: 0, floorMap: 0 } });
  });
});

describe('PUT /api/building/deactivate/:id', () => {
  test('403 for a non-owner', async () => {
    const { building } = await createOwnerWithBuilding();
    const stranger = await createUser();
    const res = await request(app).put(`/api/building/deactivate/${building.id}`).set('Cookie', stranger.cookie);
    expect(res.status).toBe(403);
  });

  test('owner deactivates; during an emergency a system log is written', async () => {
    const { building, cookie } = await createOwnerWithBuilding();
    await prisma.building.update({ where: { id: building.id }, data: { emergencyMode: true } });
    const res = await request(app).put(`/api/building/deactivate/${building.id}`).set('Cookie', cookie);
    expect(res.body).toEqual({ success: true, message: 'Building deactivated.' });
    expect((await prisma.building.findUnique({ where: { id: building.id } })).isDeactivated).toBe(true);
    expect(await prisma.log.count({ where: { buildingId: building.id, type: 'SYSTEM' } })).toBe(1);
  });
});

test('a session minted for a deleted user is rejected (whoami)', async () => {
  const token = jwt.sign({ userID: 'cxxxxxxxxxxxxxxxxxxxxxxxx', tokenVersion: 0 }, process.env.JWT_SECRET);
  const res = await request(app).get('/api/building/my').set('Cookie', [`userToken=${token}`]);
  expect(res.status).toBe(401);
});
