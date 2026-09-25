import request from 'supertest';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import {
  createUser,
  createOwnerWithBuilding,
  createFloor,
  createNode,
  connectNodes,
  addMember,
} from './helpers.js';
import { resolveDestination } from '../features/wayfinding/destinations.js';
import { buildSearchText } from '../features/mapEditor/fieldValidators.js';
import { drain } from '../services/analyticsQueue.js';

// Integration coverage for the new feature routers: map editor, wayfinding,
// emergency v2.

describe('map editor API', () => {
  test('floor + node + edge + POI lifecycle with permission gating', async () => {
    const { cookie, building, roles } = await createOwnerWithBuilding();

    // Floor create (no image — S3 guard covers uploads elsewhere)
    const floorRes = await request(app)
      .post(`/api/map-editor/buildings/${building.id}/floors`)
      .set('Cookie', cookie)
      .field('floorNumber', '1')
      .field('name', 'Ground Floor')
      .field('scalePixelsPerMeter', '10');
    expect(floorRes.status).toBe(201);
    const floor = floorRes.body.data.floor;
    expect(floor.scalePixelsPerMeter).toBe(10);

    // Duplicate floor number → 409
    const dupFloor = await request(app)
      .post(`/api/map-editor/buildings/${building.id}/floors`)
      .set('Cookie', cookie)
      .field('floorNumber', '1');
    expect(dupFloor.status).toBe(409);

    // Nodes
    const nodeA = await request(app)
      .post(`/api/map-editor/floors/${floor.id}/nodes`)
      .set('Cookie', cookie)
      .send({ x: 10, y: 10, type: 'ENTRANCE', label: 'Main door' });
    expect(nodeA.status).toBe(201);
    const nodeB = await request(app)
      .post(`/api/map-editor/floors/${floor.id}/nodes`)
      .set('Cookie', cookie)
      .send({ x: 110, y: 10, type: 'NORMAL' });
    expect(nodeB.status).toBe(201);
    const a = nodeA.body.data.node;
    const b = nodeB.body.data.node;

    // Every node is printable the moment it exists — the slug is not deferred
    // until someone opens the QR dialog.
    expect(a.qrSlug).toBe(`qr_${building.id}_1_${a.id}`);
    expect(b.qrSlug).toBe(`qr_${building.id}_1_${b.id}`);

    // Edge
    const edgeRes = await request(app)
      .post('/api/map-editor/edges')
      .set('Cookie', cookie)
      .send({ sourceNodeId: a.id, targetNodeId: b.id, buildingId: building.id });
    expect(edgeRes.status).toBe(201);
    expect(edgeRes.body.data.edge.distance).toBe(100);
    expect(edgeRes.body.data.edge.weight).toBe(100);

    // Duplicate edge → 409
    const dupEdge = await request(app)
      .post('/api/map-editor/edges')
      .set('Cookie', cookie)
      .send({ sourceNodeId: b.id, targetNodeId: a.id, buildingId: building.id });
    expect(dupEdge.status).toBe(409);

    // Moving a node recomputes edge distance
    const move = await request(app)
      .patch(`/api/map-editor/nodes/${b.id}`)
      .set('Cookie', cookie)
      .send({ x: 210 });
    expect(move.status).toBe(200);
    const movedEdge = await prisma.edge.findFirst({ where: { buildingId: building.id } });
    expect(movedEdge.distance).toBe(200);
    expect(movedEdge.weight).toBe(200); // weight tracked distance

    // POI upsert flips node type
    const poiRes = await request(app)
      .put(`/api/map-editor/nodes/${b.id}/poi`)
      .set('Cookie', cookie)
      .send({ name: 'LC Waikiki', category: 'Apparel', keywords: ['Clothes', 'fashion '] });
    expect(poiRes.status).toBe(200);
    expect(poiRes.body.data.poi.keywords).toEqual(['clothes', 'fashion']);
    const poiNode = await prisma.node.findUnique({ where: { id: b.id } });
    expect(poiNode.type).toBe('POI');

    // Viewer member cannot edit the map
    const viewer = await createUser();
    await addMember(building.id, viewer.user.id, roles['Viewer'].id);
    const denied = await request(app)
      .post(`/api/map-editor/floors/${floor.id}/nodes`)
      .set('Cookie', viewer.cookie)
      .send({ x: 1, y: 1, type: 'NORMAL' });
    expect(denied.status).toBe(403);

    // Moderator (CAN_EDIT_MAP) can
    const moderator = await createUser();
    await addMember(building.id, moderator.user.id, roles['Moderator'].id);
    const allowed = await request(app)
      .post(`/api/map-editor/floors/${floor.id}/nodes`)
      .set('Cookie', moderator.cookie)
      .send({ x: 1, y: 1, type: 'NORMAL' });
    expect(allowed.status).toBe(201);
  });

  test('floor capacity follows the owner plan: 2 free, 4 Starter, 10 Business', async () => {
    const { cookie, building, user } = await createOwnerWithBuilding();

    // Free: two floors, then the wall.
    for (let n = 1; n <= 2; n += 1) {
      const res = await request(app)
        .post(`/api/map-editor/buildings/${building.id}/floors`)
        .set('Cookie', cookie)
        .field('floorNumber', String(n));
      expect(res.status).toBe(201);
    }
    const third = await request(app)
      .post(`/api/map-editor/buildings/${building.id}/floors`)
      .set('Cookie', cookie)
      .field('floorNumber', '3');
    expect(third.status).toBe(403);
    expect(third.body.message).toMatch(/limit of 2 floors/);

    // Starter: floors 3-4 fit, the 5th is refused with an upgrade nudge.
    await prisma.user.update({ where: { id: user.id }, data: { plan: 'STARTER' } });
    for (let n = 3; n <= 4; n += 1) {
      const res = await request(app)
        .post(`/api/map-editor/buildings/${building.id}/floors`)
        .set('Cookie', cookie)
        .field('floorNumber', String(n));
      expect(res.status).toBe(201);
    }
    const fifth = await request(app)
      .post(`/api/map-editor/buildings/${building.id}/floors`)
      .set('Cookie', cookie)
      .field('floorNumber', '5');
    expect(fifth.status).toBe(403);
    expect(fifth.body.message).toMatch(/limit of 4 floors/);

    // Business unlocks up to 10.
    await prisma.user.update({ where: { id: user.id }, data: { plan: 'BUSINESS' } });
    for (let n = 5; n <= 10; n += 1) {
      const res = await request(app)
        .post(`/api/map-editor/buildings/${building.id}/floors`)
        .set('Cookie', cookie)
        .field('floorNumber', String(n));
      expect(res.status).toBe(201);
    }
    const eleventh = await request(app)
      .post(`/api/map-editor/buildings/${building.id}/floors`)
      .set('Cookie', cookie)
      .field('floorNumber', '11');
    expect(eleventh.status).toBe(403);
    expect(eleventh.body.message).toMatch(/limit of 10 floors/);
  });

  test('transit links require different floors; validation reports issues', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const f1 = await createFloor(building.id, { floorNumber: 1 });
    const f2 = await createFloor(building.id, { floorNumber: 2 });
    const t1 = await createNode(building.id, f1.id, { x: 0, y: 0, type: 'TRANSIT' });
    const t1b = await createNode(building.id, f1.id, { x: 9, y: 0, type: 'TRANSIT' });
    const t2 = await createNode(building.id, f2.id, { x: 0, y: 0, type: 'TRANSIT' });

    const sameFloor = await request(app)
      .post('/api/map-editor/transit-links')
      .set('Cookie', cookie)
      .send({ nodeIds: [t1.id, t1b.id], transitType: 'ELEVATOR', buildingId: building.id });
    expect(sameFloor.status).toBe(422);

    const link = await request(app)
      .post('/api/map-editor/transit-links')
      .set('Cookie', cookie)
      .send({ nodeIds: [t1.id, t2.id], transitType: 'ELEVATOR', buildingId: building.id });
    expect(link.status).toBe(201);
    expect(link.body.data.edge.transitType).toBe('ELEVATOR');
    expect(link.body.data.edge.accessible).toBe(true);
    expect(link.body.data.edge.weight).toBe(300);

    const validation = await request(app)
      .get(`/api/map-editor/buildings/${building.id}/validate`)
      .set('Cookie', cookie);
    expect(validation.status).toBe(200);
    expect(validation.body.data.ok).toBe(false); // no exits anywhere
    const codes = validation.body.data.issues.map((i) => i.code);
    expect(codes).toContain('NO_EXIT');
    expect(codes).toContain('ORPHAN_NODE'); // t1b has no edges
  });

  test('auto-connect wires the floor once, respects walls, and is idempotent', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, {
      floorNumber: 1,
      drawing: {
        version: 1,
        // Vertical wall at x=500 spanning y 0..800 — splits the floor.
        shapes: [{ id: 'w', kind: 'wall', points: [500, 0, 500, 800], thickness: 6 }],
      },
    });
    const a = await createNode(building.id, floor.id, { x: 100, y: 100 });
    const b = await createNode(building.id, floor.id, { x: 300, y: 100 });
    const c = await createNode(building.id, floor.id, { x: 900, y: 100 });

    const first = await request(app)
      .post(`/api/map-editor/floors/${floor.id}/auto-connect`)
      .set('Cookie', cookie);
    expect(first.status).toBe(200);

    const createdPairs = first.body.data.edges.map((e) =>
      [e.sourceNodeId, e.targetNodeId].sort().join(':'),
    );
    // a-b connect; nothing crosses the wall to c.
    expect(createdPairs).toContain([a.id, b.id].sort().join(':'));
    expect(createdPairs.some((k) => k.includes(c.id))).toBe(false);

    // Second run: nothing left to do.
    const second = await request(app)
      .post(`/api/map-editor/floors/${floor.id}/auto-connect`)
      .set('Cookie', cookie);
    expect(second.status).toBe(200);
    expect(second.body.data.edges).toHaveLength(0);
  });

  test('a hand-drawn floor plan round-trips through create, patch and clear', async () => {
    const { cookie, building } = await createOwnerWithBuilding();

    // A floor drawn rather than uploaded carries its own canvas size, derived
    // from the room dimensions the user typed.
    const created = await request(app)
      .post(`/api/map-editor/buildings/${building.id}/floors`)
      .set('Cookie', cookie)
      .field('floorNumber', '1')
      .field('width', '1000')
      .field('height', '800')
      .field('scalePixelsPerMeter', '50');
    expect(created.status).toBe(201);
    const floor = created.body.data.floor;
    expect(floor.width).toBe(1000);
    expect(floor.height).toBe(800);

    // Drawings travel as a JSON string in a multipart field.
    const drawing = {
      version: 1,
      shapes: [
        { id: 'a', kind: 'room', x: 0, y: 0, width: 100, height: 50, name: 'Lobby' },
        {
          id: 'b',
          kind: 'shop',
          x: 200,
          y: 0,
          width: 80,
          height: 60,
          name: 'Cafe',
          logoUrl: 'javascript:alert(1)', // must not survive
        },
        { id: 'c', kind: 'icon', x: 40, y: 40, icon: 'ELEVATOR' },
        { id: 'd', kind: 'nonsense', x: 0, y: 0 }, // unknown kind, dropped
      ],
    };

    const patched = await request(app)
      .patch(`/api/map-editor/floors/${floor.id}`)
      .set('Cookie', cookie)
      .field('drawing', JSON.stringify(drawing));
    expect(patched.status).toBe(200);

    const saved = patched.body.data.floor.drawing;
    expect(saved.shapes.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    // The dangerous URL is stripped rather than the whole save being rejected.
    expect(saved.shapes[1].logoUrl).toBeUndefined();
    expect(saved.shapes[1].name).toBe('Cafe');

    // The graph endpoint the editor loads from hands the drawing back.
    const graph = await request(app)
      .get(`/api/map-editor/buildings/${building.id}/graph`)
      .set('Cookie', cookie);
    expect(graph.status).toBe(200);
    expect(graph.body.data.floors[0].drawing.shapes).toHaveLength(3);

    // An empty field clears the drawing without touching anything else.
    const cleared = await request(app)
      .patch(`/api/map-editor/floors/${floor.id}`)
      .set('Cookie', cookie)
      .field('drawing', '');
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.floor.drawing).toBeNull();
    expect(cleared.body.data.floor.width).toBe(1000); // untouched

    // An oversized shape list is refused outright.
    const tooMany = await request(app)
      .patch(`/api/map-editor/floors/${floor.id}`)
      .set('Cookie', cookie)
      .field(
        'drawing',
        JSON.stringify({
          shapes: Array.from({ length: 2001 }, () => ({
            kind: 'icon',
            x: 0,
            y: 0,
            icon: 'WC',
          })),
        }),
      );
    expect(tooMany.status).toBe(422);
  });

  test('edge writes carry direction, tags, rank, visibility and lengthM', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, { floorNumber: 1 });
    const a = await createNode(building.id, floor.id, { x: 0, y: 0 });
    const b = await createNode(building.id, floor.id, { x: 300, y: 0 });

    const created = await request(app)
      .post('/api/map-editor/edges')
      .set('Cookie', cookie)
      .send({
        sourceNodeId: a.id,
        targetNodeId: b.id,
        buildingId: building.id,
        direction: 'FORWARD',
        tags: [' Stroller ', 'STROLLER', 'quiet'],
        rank: 'SECONDARY',
        visibility: 'STAFF',
        lengthM: 6,
      });
    expect(created.status).toBe(201);
    const edge = created.body.data.edge;
    expect(edge.tags).toEqual(['stroller', 'quiet']);
    expect(edge.rank).toBe('SECONDARY');
    expect(edge.visibility).toBe('STAFF');
    expect(edge.lengthM).toBe(6);
    // `direction` reads against the edge's stored source/target, the same ones
    // the response carries — so what POST returns is what a later PATCH of the
    // same value reproduces. (Storage order itself is pinned in
    // edgeService.test.js, in both cuid orderings.)
    expect(edge.direction).toBe('FORWARD');

    const repatched = await request(app)
      .patch(`/api/map-editor/edges/${edge.id}`)
      .set('Cookie', cookie)
      .send({ direction: edge.direction });
    expect(repatched.status).toBe(200);
    expect(repatched.body.data.edge).toMatchObject({
      direction: 'FORWARD',
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
    });

    const patched = await request(app)
      .patch(`/api/map-editor/edges/${edge.id}`)
      .set('Cookie', cookie)
      .send({
        direction: 'BOTH',
        tags: ['step_free'],
        rank: 'PRIMARY',
        visibility: 'PUBLIC',
        lengthM: 12.5,
      });
    expect(patched.status).toBe(200);
    expect(patched.body.data.edge).toMatchObject({
      direction: 'BOTH',
      tags: ['step_free'],
      rank: 'PRIMARY',
      visibility: 'PUBLIC',
      lengthM: 12.5,
    });

    // null clears the measured length so the graph loader derives it again.
    const reset = await request(app)
      .patch(`/api/map-editor/edges/${edge.id}`)
      .set('Cookie', cookie)
      .send({ lengthM: null });
    expect(reset.status).toBe(200);
    expect(reset.body.data.edge.lengthM).toBeNull();

    const bogus = await request(app)
      .patch(`/api/map-editor/edges/${edge.id}`)
      .set('Cookie', cookie)
      .send({ direction: 'SIDEWAYS' });
    expect(bogus.status).toBe(422);
  });

  test('node PATCH stores visibility and externalId; a duplicate code is a 409', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, { floorNumber: 1 });
    const a = await createNode(building.id, floor.id);
    const b = await createNode(building.id, floor.id, { x: 200 });

    const first = await request(app)
      .patch(`/api/map-editor/nodes/${a.id}`)
      .set('Cookie', cookie)
      .send({ visibility: 'STAFF', externalId: ' BOOTH-12 ' });
    expect(first.status).toBe(200);
    expect(first.body.data.node.visibility).toBe('STAFF');
    expect(first.body.data.node.externalId).toBe('BOOTH-12');

    const clash = await request(app)
      .patch(`/api/map-editor/nodes/${b.id}`)
      .set('Cookie', cookie)
      .send({ externalId: 'BOOTH-12' });
    expect(clash.status).toBe(409);
    expect(clash.body.message).toMatch(/BOOTH-12/);

    const cleared = await request(app)
      .patch(`/api/map-editor/nodes/${a.id}`)
      .set('Cookie', cookie)
      .send({ externalId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.node.externalId).toBeNull();

    // The code is free again once cleared.
    const reused = await request(app)
      .patch(`/api/map-editor/nodes/${b.id}`)
      .set('Cookie', cookie)
      .send({ externalId: 'BOOTH-12' });
    expect(reused.status).toBe(200);
  });

  test('floors accept verticalOrder (negative allowed) and a short name', async () => {
    const { cookie, building } = await createOwnerWithBuilding();

    const created = await request(app)
      .post(`/api/map-editor/buildings/${building.id}/floors`)
      .set('Cookie', cookie)
      .field('floorNumber', '0')
      .field('verticalOrder', '-1')
      .field('shortName', 'B1');
    expect(created.status).toBe(201);
    expect(created.body.data.floor.verticalOrder).toBe(-1);
    expect(created.body.data.floor.shortName).toBe('B1');

    const floor = created.body.data.floor;
    const patched = await request(app)
      .patch(`/api/map-editor/floors/${floor.id}`)
      .set('Cookie', cookie)
      .field('verticalOrder', '3')
      .field('shortName', 'M2');
    expect(patched.status).toBe(200);
    expect(patched.body.data.floor.verticalOrder).toBe(3);
    expect(patched.body.data.floor.shortName).toBe('M2');

    const tooLong = await request(app)
      .patch(`/api/map-editor/floors/${floor.id}`)
      .set('Cookie', cookie)
      .field('shortName', 'a'.repeat(17));
    expect(tooLong.status).toBe(422);

    const notAnInt = await request(app)
      .patch(`/api/map-editor/floors/${floor.id}`)
      .set('Cookie', cookie)
      .field('verticalOrder', '1.5');
    expect(notAnInt.status).toBe(422);
  });

  test('POI write stores names, searchText and a buildingId that ext: can find', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, { floorNumber: 1 });
    const node = await createNode(building.id, floor.id);

    const saved = await request(app)
      .put(`/api/map-editor/nodes/${node.id}/poi`)
      .set('Cookie', cookie)
      .send({
        name: 'Coffee House',
        keywords: ['Espresso'],
        externalId: 'SKU-9',
        names: { en: 'Coffee House', ka: 'ყავის სახლი', aliases: ['Cafe', 'cafe'] },
      });
    expect(saved.status).toBe(200);
    expect(saved.body.data.poi.externalId).toBe('SKU-9');
    expect(saved.body.data.poi.names).toEqual({
      en: 'Coffee House',
      ka: 'ყავის სახლი',
      aliases: ['Cafe'],
    });

    const stored = await prisma.poi.findUnique({ where: { nodeId: node.id } });
    // Without buildingId every ext: lookup scoped by building misses it.
    expect(stored.buildingId).toBe(building.id);
    expect(stored.searchText).toBe('coffee house espresso ყავის სახლი cafe');

    const resolved = await resolveDestination(building.id, 'ext:SKU-9');
    expect(resolved).toMatchObject({ ok: true, nodeId: node.id });

    // Another building's POI with the same code stays out of reach.
    const other = await createOwnerWithBuilding();
    const otherMiss = await resolveDestination(other.building.id, 'ext:SKU-9');
    expect(otherMiss.ok).toBe(false);
  });

  test('a POI save that omits names and externalId leaves them alone', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, { floorNumber: 1 });
    const node = await createNode(building.id, floor.id);
    const url = `/api/map-editor/nodes/${node.id}/poi`;

    await request(app)
      .put(url)
      .set('Cookie', cookie)
      .send({
        name: 'Coffee House',
        keywords: ['Espresso'],
        externalId: 'SKU-9',
        names: { en: 'Coffee House', ka: 'ყავის სახლი', aliases: ['Cafe'] },
      });

    // Exactly what the shipped editor sends today: no names, no externalId.
    const legacySave = await request(app)
      .put(url)
      .set('Cookie', cookie)
      .send({
        buildingId: building.id,
        name: 'Coffee House',
        category: 'Cafe',
        description: null,
        keywords: ['Espresso'],
      });
    expect(legacySave.status).toBe(200);
    expect(legacySave.body.data.poi.externalId).toBe('SKU-9');
    expect(legacySave.body.data.poi.names).toEqual({
      en: 'Coffee House',
      ka: 'ყავის სახლი',
      aliases: ['Cafe'],
    });
    // searchText is rebuilt, so it has to be rebuilt from the kept values.
    expect(legacySave.body.data.poi.searchText).toBe(
      'coffee house espresso ყავის სახლი cafe'
    );
    const stillResolves = await resolveDestination(building.id, 'ext:SKU-9');
    expect(stillResolves).toMatchObject({ ok: true, nodeId: node.id });

    // Clearing stays possible — it just has to be asked for.
    const cleared = await request(app)
      .put(url)
      .set('Cookie', cookie)
      .send({ name: 'Coffee House', externalId: null, names: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.poi.externalId).toBeNull();
    expect(cleared.body.data.poi.names).toBeNull();
    expect(cleared.body.data.poi.searchText).toBe('coffee house');
    expect((await resolveDestination(building.id, 'ext:SKU-9')).ok).toBe(false);
  });

  test('routing profile round-trips and rejects invalid tuning', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const url = `/api/map-editor/buildings/${building.id}/routing-profile`;

    const put = await request(app)
      .put(url)
      .set('Cookie', cookie)
      .send({ routingProfile: { walkSpeedMps: 1.1, northOffsetDeg: -15 } });
    expect(put.status).toBe(200);
    expect(put.body.data.routingProfile).toEqual({
      walkSpeedMps: 1.1,
      northOffsetDeg: -15,
    });

    const get = await request(app).get(url).set('Cookie', cookie);
    expect(get.status).toBe(200);
    expect(get.body.data.routingProfile.walkSpeedMps).toBe(1.1);
    // The effective profile layers the overrides over the defaults.
    expect(get.body.data.effective.walkSpeedMps).toBe(1.1);
    expect(get.body.data.effective.elevatorWaitSec).toBe(30);

    const unknownKey = await request(app)
      .put(url)
      .set('Cookie', cookie)
      .send({ routingProfile: { teleportSpeed: 9 } });
    expect(unknownKey.status).toBe(422);
    expect(unknownKey.body.message).toMatch(/teleportSpeed/);
    // Structured too, so the editor can highlight the offending field rather
    // than parsing a sentence.
    expect(unknownKey.body.errors).toEqual([
      expect.stringContaining('teleportSpeed'),
    ]);

    const zeroSpeed = await request(app)
      .put(url)
      .set('Cookie', cookie)
      .send({ routingProfile: { walkSpeedMps: 0 } });
    expect(zeroSpeed.status).toBe(422);

    // The stored profile is untouched by a rejected write.
    const unchanged = await prisma.building.findUnique({ where: { id: building.id } });
    expect(unchanged.routingProfile).toEqual({ walkSpeedMps: 1.1, northOffsetDeg: -15 });

    const cleared = await request(app)
      .put(url)
      .set('Cookie', cookie)
      .send({ routingProfile: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.routingProfile).toBeNull();
  });
});

describe('wayfinding API', () => {
  async function seedMall() {
    const seeded = await createOwnerWithBuilding();
    const { building } = seeded;
    const f1 = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 10 });
    const f4 = await createFloor(building.id, { floorNumber: 4, scalePixelsPerMeter: 10 });
    const entrance = await createNode(building.id, f1.id, { x: 0, y: 0, type: 'ENTRANCE' });
    const esc1 = await createNode(building.id, f1.id, { x: 100, y: 0, type: 'TRANSIT', label: 'Escalator A' });
    const esc4 = await createNode(building.id, f4.id, { x: 100, y: 0, type: 'TRANSIT', label: 'Escalator A' });
    const shopNode = await createNode(building.id, f4.id, { x: 300, y: 0, type: 'POI' });
    const exit1 = await createNode(building.id, f1.id, { x: 50, y: 50, type: 'EMERGENCY_EXIT' });
    await connectNodes(entrance, esc1);
    await connectNodes(esc1, esc4, { transitType: 'ESCALATOR', weight: 350, distance: 0, accessible: false });
    await connectNodes(esc4, shopNode);
    await connectNodes(entrance, exit1);
    const keywords = ['clothes', 'fashion'];
    const poi = await prisma.poi.create({
      data: {
        nodeId: shopNode.id,
        buildingId: building.id,
        name: 'LC Waikiki',
        category: 'Apparel',
        keywords,
        // Written the same way the map-editor route computes it on save —
        // this fixture is created directly through Prisma, so the search
        // blob has to be built by hand to match a real row.
        searchText: buildSearchText({ name: 'LC Waikiki', keywords }),
      },
    });
    return { ...seeded, f1, f4, entrance, esc1, esc4, shopNode, exit1, poi };
  }

  test('POI search matches name and keywords', async () => {
    const { building } = await seedMall();
    const byName = await request(app).get(
      `/api/wayfinding/buildings/${building.id}/pois?q=waikiki`
    );
    expect(byName.status).toBe(200);
    expect(byName.body.data.pois).toHaveLength(1);
    expect(byName.body.data.pois[0]).toMatchObject({
      name: 'LC Waikiki',
      floorNumber: 4,
    });

    const byKeyword = await request(app).get(
      `/api/wayfinding/buildings/${building.id}/pois?q=clothes`
    );
    expect(byKeyword.body.data.pois).toHaveLength(1);

    // The response also carries a searchId (for the pick endpoint) and each
    // POI's localized names, alongside the externalId it already returned.
    expect(byName.body.data.searchId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(byName.body.data.pois[0]).toMatchObject({ names: null, externalId: null });
  });

  test('POI search matches category — buildSearchText does not fold category in, so this branch is load-bearing on its own', async () => {
    const { building, poi } = await seedMall(); // category: 'Apparel'

    // Prove category search is NOT riding on searchText: it was never folded
    // in there, so if the category OR-branch regressed, this would fail.
    const stored = await prisma.poi.findUnique({ where: { id: poi.id } });
    expect(stored.searchText).not.toMatch(/apparel/);

    const byCategory = await request(app).get(
      `/api/wayfinding/buildings/${building.id}/pois?q=apparel`
    );
    expect(byCategory.status).toBe(200);
    expect(byCategory.body.data.pois.map((p) => p.name)).toContain('LC Waikiki');
  });

  test('a well-formed but nonexistent buildingId is a 404, not a quiet empty 200', async () => {
    // Valid legacy-id shape (24 hex chars) per isId(), but never persisted —
    // must not reach the database as a "real" building, and must never
    // enqueue a searchEvent write (its FK to Building would fail and get
    // silently swallowed, which is exactly the log-spam surface being closed).
    const fakeBuildingId = 'a'.repeat(24);
    const res = await request(app).get(
      `/api/wayfinding/buildings/${fakeBuildingId}/pois?q=anything`
    );
    expect(res.status).toBe(404);

    await drain();
    const count = await prisma.searchEvent.count();
    expect(count).toBe(0);
  });

  test('POI search matches a Georgian alias, and a legacy row with no names/searchText still matches by name', async () => {
    const { building, f4 } = await seedMall();

    // A POI saved the way the real map-editor write path builds it: name,
    // English/Georgian names and an alias folded into searchText by
    // buildSearchText, exactly as fieldValidators.js does on every save.
    const cafeNode = await createNode(building.id, f4.id, { x: 400, y: 0, type: 'POI' });
    const names = { en: 'Coffee House', ka: 'ყავის სახლი', aliases: ['Kava'] };
    await prisma.poi.create({
      data: {
        nodeId: cafeNode.id,
        buildingId: building.id,
        name: 'Coffee House',
        names,
        searchText: buildSearchText({ name: 'Coffee House', names }),
      },
    });

    const byGeorgianName = await request(app).get(
      `/api/wayfinding/buildings/${building.id}/pois?q=${encodeURIComponent('ყავის')}`
    );
    expect(byGeorgianName.status).toBe(200);
    expect(byGeorgianName.body.data.pois.map((p) => p.name)).toContain('Coffee House');

    const byAlias = await request(app).get(
      `/api/wayfinding/buildings/${building.id}/pois?q=kava`
    );
    expect(byAlias.body.data.pois.map((p) => p.name)).toContain('Coffee House');

    // A row with neither `names` nor `searchText` populated (as an older,
    // pre-slice row would still be after the migration's backfill covered
    // only name + keywords) must still be findable by its plain name.
    const legacyNode = await createNode(building.id, f4.id, { x: 500, y: 0, type: 'POI' });
    await prisma.poi.create({
      data: {
        nodeId: legacyNode.id,
        buildingId: building.id,
        name: 'Legacy Kiosk',
        // names and searchText intentionally left null/unset.
      },
    });
    const byLegacyName = await request(app).get(
      `/api/wayfinding/buildings/${building.id}/pois?q=legacy`
    );
    expect(byLegacyName.body.data.pois.map((p) => p.name)).toContain('Legacy Kiosk');
  });

  test('directory: POIs, named drawn rooms and labeled nodes — doors excluded', async () => {
    const { building } = await createOwnerWithBuilding();

    const corridorNode = { x: 120, y: 120 }; // near the drawn room below
    const floor = await createFloor(building.id, {
      floorNumber: 1,
      name: 'Ground',
      drawing: {
        version: 1,
        shapes: [
          // Named room with NO linked node: still a destination — it routes
          // via the nearest node in range.
          { id: 'r1', kind: 'room', x: 50, y: 50, width: 100, height: 100, name: 'Waikiki' },
          // Named room too far from any node: unroutable, so omitted.
          { id: 'r2', kind: 'room', x: 5000, y: 5000, width: 50, height: 50, name: 'Far Room' },
          // Door marker: navigation furniture, not a destination.
          { id: 'd1', kind: 'icon', x: 60, y: 60, icon: 'DOOR', nodeId: 'DOOR_NODE' },
        ],
      },
    });

    const near = await createNode(building.id, floor.id, {
      ...corridorNode, type: 'NORMAL',
    });
    const poiNode = await createNode(building.id, floor.id, { x: 10, y: 10, type: 'POI' });
    await prisma.poi.create({
      data: { nodeId: poiNode.id, name: 'Cafe Aroma', category: 'coffee' },
    });
    const exit = await createNode(building.id, floor.id, {
      x: 300, y: 10, type: 'EMERGENCY_EXIT', label: 'Main Exit',
    });
    const doorNode = await createNode(building.id, floor.id, {
      x: 62, y: 62, type: 'NORMAL', label: 'Door',
    });
    // Point the drawing's door marker at the real node id.
    await prisma.floor.update({
      where: { id: floor.id },
      data: {
        drawing: {
          version: 1,
          shapes: [
            { id: 'r1', kind: 'room', x: 50, y: 50, width: 100, height: 100, name: 'Waikiki' },
            { id: 'r2', kind: 'room', x: 5000, y: 5000, width: 50, height: 50, name: 'Far Room' },
            { id: 'd1', kind: 'icon', x: 60, y: 60, icon: 'DOOR', nodeId: doorNode.id },
          ],
        },
      },
    });
    // Unlabeled node: not a destination anyone can name — stays out.
    await createNode(building.id, floor.id, { x: 90, y: 10, type: 'NORMAL' });

    const res = await request(app).get(
      `/api/wayfinding/buildings/${building.id}/directory`,
    );
    expect(res.status).toBe(200);

    const entries = res.body.data.entries;
    expect(entries.map((e) => e.name)).toEqual(['Cafe Aroma', 'Main Exit', 'Waikiki']);

    // The drawn room routes via the nearest in-range node.
    const waikiki = entries.find((e) => e.name === 'Waikiki');
    expect(waikiki).toMatchObject({ kind: 'shape', nodeId: near.id, floorNumber: 1 });

    // Doors are not searchable; the far room is unroutable and omitted.
    expect(entries.some((e) => e.name === 'Door')).toBe(false);
    expect(entries.some((e) => e.name === 'Far Room')).toBe(false);
    expect(entries.find((e) => e.name === 'Main Exit')).toMatchObject({
      kind: 'node', nodeId: exit.id, nodeType: 'EMERGENCY_EXIT',
    });
  });

  test('multi-floor route to a POI returns stepper segments', async () => {
    const { entrance, poi } = await seedMall();
    const res = await request(app).get(
      `/api/wayfinding/route?from=${entrance.id}&to=poi:${poi.id}`
    );
    expect(res.status).toBe(200);
    const route = res.body.data.route;
    expect(route.mode).toBe('WAYFINDING');
    expect(route.destination.poi.name).toBe('LC Waikiki');
    expect(route.segments).toHaveLength(2);
    expect(route.transitions).toHaveLength(1);
    expect(route.transitions[0]).toMatchObject({
      transitType: 'ESCALATOR',
      fromFloorNumber: 1,
      toFloorNumber: 4,
      direction: 'up',
      label: 'Escalator A',
    });
    expect(route.steps.map((s) => s.kind)).toEqual(['walk', 'transit', 'walk', 'arrive']);
    // meters via scalePixelsPerMeter=10: floor1 100px=10m, floor4 200px=20m
    expect(route.totalDistanceMeters).toBe(30);
    // v2 additive fields ride along unchanged: ETA + profile name, and the
    // legacy `totalDistanceMeters` promise above is untouched.
    expect(route.profile).toBe('walk');
    expect(typeof route.totalDurationSec).toBe('number');
    expect(route.totalDurationSec).toBeGreaterThan(0);
  });

  test('route carries bilingual turn-by-turn instructions', async () => {
    const { entrance, poi } = await seedMall();
    const res = await request(app).get(
      `/api/wayfinding/route?from=${entrance.id}&to=poi:${poi.id}`
    );
    expect(res.status).toBe(200);
    const instructions = res.body.data.route.instructions;
    expect(Array.isArray(instructions)).toBe(true);
    expect(instructions[0].kind).toBe('depart');
    expect(instructions.at(-1).kind).toBe('arrive');
    expect(instructions.some((i) => i.kind === 'transit')).toBe(true);
    for (const instruction of instructions) {
      expect(instruction.text.en.trim()).not.toBe('');
      expect(instruction.text.ka.trim()).not.toBe('');
    }
  });

  test('?heading= phrases the opening instruction against the compass', async () => {
    const { entrance, poi } = await seedMall();
    const url = `/api/wayfinding/route?from=${entrance.id}&to=poi:${poi.id}`;
    const plain = await request(app).get(url);
    // The first leg runs due east on the map; facing north means turning right.
    const facing = await request(app).get(`${url}&heading=0`);

    expect(facing.status).toBe(200);
    const opening = facing.body.data.route.instructions[0];
    expect(opening.text.en).toMatch(/right/i);
    expect(opening.text.en).not.toBe(
      plain.body.data.route.instructions[0].text.en
    );
    // `kind` drives the arrow rotation on the shipped stepper — it must be the
    // turn the text describes, not a straight-up `depart`.
    expect(opening.kind).toBe('right');
    expect(plain.body.data.route.instructions[0].kind).toBe('depart');
  });

  test('accessible route falls back with a flag when only escalators exist', async () => {
    const { entrance, poi } = await seedMall();
    const res = await request(app).get(
      `/api/wayfinding/route?from=${entrance.id}&to=poi:${poi.id}&accessible=true`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.route.accessibleRouteUnavailable).toBe(true);
  });

  test('to=ext:<code> resolves inside the building only', async () => {
    const { entrance, shopNode } = await seedMall();
    await prisma.poi.update({
      where: { nodeId: shopNode.id },
      data: { externalId: 'SHOP-42' },
    });

    const res = await request(app).get(
      `/api/wayfinding/route?from=${entrance.id}&to=ext:SHOP-42`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.route.destination.nodeId).toBe(shopNode.id);

    // The same code registered in a *different* building must not resolve
    // against this building's origin.
    const other = await createOwnerWithBuilding();
    const otherFloor = await createFloor(other.building.id, { floorNumber: 1 });
    await createNode(other.building.id, otherFloor.id, {
      x: 0,
      y: 0,
      type: 'POI',
      externalId: 'ONLY-OTHER-BUILDING',
    });

    const cross = await request(app).get(
      `/api/wayfinding/route?from=${entrance.id}&to=ext:ONLY-OTHER-BUILDING`
    );
    expect(cross.status).toBe(404);
  });

  test('excludeTags=service relaxes when it is the route\'s only connector', async () => {
    const { entrance, poi } = await seedMall();
    // Tag the only cross-floor connector as 'service'; excluding it leaves no
    // route at all, so the router should relax the tag constraint rather
    // than report failure.
    const escalatorEdge = await prisma.edge.findFirst({ where: { transitType: 'ESCALATOR' } });
    await prisma.edge.update({
      where: { id: escalatorEdge.id },
      data: { tags: ['service'] },
    });

    const res = await request(app).get(
      `/api/wayfinding/route?from=${entrance.id}&to=poi:${poi.id}&excludeTags=service`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.route.tagConstraintsRelaxed).toBe(true);
  });

  test('accessible + excludeTags relax cumulatively: reports both flags when only the final fallback succeeds', async () => {
    const { entrance, poi } = await seedMall();
    // The only cross-floor connector is both 'service'-tagged AND
    // inaccessible (seedMall already sets accessible:false on it), so a
    // wheelchair request excluding 'service' can only succeed once BOTH
    // constraints are gone — the final, most-relaxed fallback step. Both
    // flags must say so; reporting only the winning step's own label would
    // under-report that tags were dropped too along the way.
    const escalatorEdge = await prisma.edge.findFirst({ where: { transitType: 'ESCALATOR' } });
    await prisma.edge.update({
      where: { id: escalatorEdge.id },
      data: { tags: ['service'] },
    });

    const res = await request(app).get(
      `/api/wayfinding/route?from=${entrance.id}&to=poi:${poi.id}&accessible=true&excludeTags=service`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.route.tagConstraintsRelaxed).toBe(true);
    expect(res.body.data.route.accessibleRouteUnavailable).toBe(true);
  });

  describe('multi-stop routing (B12)', () => {
    /** Three colinear stops off one entrance, so "sensible order" is
     *  unambiguous: nearest first, farthest last, never backtracking. */
    async function seedLine() {
      const seeded = await createOwnerWithBuilding();
      const { building } = seeded;
      const floor = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 10 });
      const entrance = await createNode(building.id, floor.id, { x: 0, y: 0, type: 'ENTRANCE' });
      const near = await createNode(building.id, floor.id, { x: 50, y: 0, type: 'POI' });
      const far = await createNode(building.id, floor.id, { x: 200, y: 0, type: 'POI' });
      const island = await createNode(building.id, floor.id, { x: 900, y: 0, type: 'POI' }); // no edges: unreachable
      await connectNodes(entrance, near);
      await connectNodes(near, far);
      const nearPoi = await prisma.poi.create({ data: { nodeId: near.id, name: 'Near Shop' } });
      const farPoi = await prisma.poi.create({ data: { nodeId: far.id, name: 'Far Shop' } });
      const islandPoi = await prisma.poi.create({ data: { nodeId: island.id, name: 'Stranded Kiosk' } });
      return { ...seeded, entrance, near, far, island, nearPoi, farPoi, islandPoi };
    }

    test('a single `to` produces a payload with no legs/stops/stopIndex — byte-identical to a plain point-to-point route', async () => {
      const { entrance, poi } = await seedMall();
      const res = await request(app).get(
        `/api/wayfinding/route?from=${entrance.id}&to=poi:${poi.id}`
      );
      expect(res.status).toBe(200);
      const route = res.body.data.route;
      expect(route.legs).toBeUndefined();
      expect(route.stops).toBeUndefined();
      // Per-key, not `arrayContaining` (which is satisfied the moment EITHER
      // key is absent) — a regression that reintroduced only one of the two
      // must still fail this test.
      expect(Object.hasOwn(route, 'legs')).toBe(false);
      expect(Object.hasOwn(route, 'stops')).toBe(false);
      for (const instruction of route.instructions) {
        expect(instruction.stopIndex).toBeUndefined();
      }
    });

    test('to=a&to=b visits them in the optimized order, not the request order', async () => {
      const { entrance, near, far, nearPoi, farPoi } = await seedLine();
      // Requested far-then-near; the sensible walk is near-then-far (no
      // backtracking past the shop the visitor already reached).
      const res = await request(app).get(
        `/api/wayfinding/route?from=${entrance.id}&to=${far.id}&to=${near.id}`
      );
      expect(res.status).toBe(200);
      const route = res.body.data.route;

      expect(route.legs).toHaveLength(2);
      expect(route.legs.map((leg) => leg.toNodeId)).toEqual([near.id, far.id]);
      expect(route.legs[0].poi).toMatchObject({ id: nearPoi.id, name: 'Near Shop' });
      expect(route.legs[1].poi).toMatchObject({ id: farPoi.id, name: 'Far Shop' });

      expect(route.stops).toHaveLength(2);
      expect(route.stops.map((s) => s.nodeId)).toEqual([near.id, far.id]);
      expect(route.stops[0].stopIndex).toBe(0);
      expect(route.stops[1].stopIndex).toBe(1);
      expect(route.stops[1].distanceFromStartM).toBeGreaterThan(route.stops[0].distanceFromStartM);

      // The whole trip still renders like any other route: one continuous
      // path ending at the LAST stop visited (far), not the last one typed.
      expect(route.destination.nodeId).toBe(far.id);
      expect(route.mode).toBe('WAYFINDING');

      // The final stop is always the route's real destination, so it gets a
      // real, localized arrive instruction carrying its stopIndex.
      const arrive = route.instructions.at(-1);
      expect(arrive.kind).toBe('arrive');
      expect(arrive.stopIndex).toBe(1);
    });

    test('an unreachable stop 404s naming it, rather than silently dropping it from the plan', async () => {
      const { entrance, near, island, islandPoi } = await seedLine();
      const res = await request(app).get(
        `/api/wayfinding/route?from=${entrance.id}&to=${near.id}&to=${island.id}`
      );
      expect(res.status).toBe(404);
      expect(res.body.message).toContain(islandPoi.name);
    });

    test('more than 8 destinations is refused outright (422), not silently truncated', async () => {
      const { entrance, near, far } = await seedLine();
      // Alternating ids so no two ADJACENT `to`s are identical — otherwise
      // the same adjacent-duplicate collapsing `parseDestinations` applies
      // would hide the overflow this test exists to catch.
      const manyTo = Array.from({ length: 9 }, (_, i) => `to=${i % 2 === 0 ? near.id : far.id}`).join(
        '&'
      );
      const res = await request(app).get(`/api/wayfinding/route?from=${entrance.id}&${manyTo}`);
      expect(res.status).toBe(422);
    });

    test('accessible=true with one inaccessible leg falls back for the WHOLE plan and warns, rather than 404ing', async () => {
      // seedMall's only floor1<->floor4 connector is an inaccessible
      // escalator; exit1 sits on floor1 (an ordinary accessible edge from
      // entrance), the POI sits on floor4 (only reachable via that
      // escalator). Under strict wheelchair routing, the second leg has no
      // step-free path at all — the whole PLAN must relax, not just that leg.
      const { entrance, exit1, shopNode, poi } = await seedMall();
      const res = await request(app).get(
        `/api/wayfinding/route?from=${entrance.id}&to=${exit1.id}&to=poi:${poi.id}&accessible=true`
      );
      expect(res.status).toBe(200);
      const route = res.body.data.route;

      // A route, not a 404: the visitor still needs to get there, so they are
      // routed and warned, exactly like a single-destination wheelchair
      // request under the same topology would be.
      expect(route.accessible).toBe(true);
      expect(route.accessibleRouteUnavailable).toBe(true);
      expect(route.legs).toHaveLength(2);
      expect(route.legs[1].toNodeId).toBe(shopNode.id);

      // The warning names which floors and how far in, same as a
      // single-destination accessible route reports it.
      const inaccessible = route.warnings.filter((w) => w.code === 'INACCESSIBLE_STEP');
      expect(inaccessible.length).toBeGreaterThan(0);
      expect(inaccessible[0]).toMatchObject({
        segmentIndex: expect.any(Number),
        distanceFromStartM: expect.any(Number),
      });
    });

    test('accessible=true + excludeTags relax cumulatively for the whole plan, same as a single destination', async () => {
      // Tag the only floor1<->floor4 connector 'service' AND leave it
      // inaccessible (seedMall's default): excluding the tag alone is not
      // enough for the whole plan to succeed, so accessibility must drop
      // too — and both flags must say so, exactly like the existing
      // single-destination cumulative-relaxation test above.
      const { entrance, exit1, shopNode, poi } = await seedMall();
      const escalatorEdge = await prisma.edge.findFirst({ where: { transitType: 'ESCALATOR' } });
      await prisma.edge.update({ where: { id: escalatorEdge.id }, data: { tags: ['service'] } });

      const res = await request(app).get(
        `/api/wayfinding/route?from=${entrance.id}&to=${exit1.id}&to=poi:${poi.id}` +
          `&accessible=true&excludeTags=service`
      );
      expect(res.status).toBe(200);
      const route = res.body.data.route;
      expect(route.tagConstraintsRelaxed).toBe(true);
      expect(route.accessibleRouteUnavailable).toBe(true);
      expect(route.legs[1].toNodeId).toBe(shopNode.id);
    });

    test('a destination requested twice (a round trip) is walked in request order, never collapsed adjacent', async () => {
      const { entrance, near, far } = await seedLine();
      // far, then back near, then far again: a genuine round trip. If the
      // ordering optimizer ran at all, it would see two zero-distance copies
      // of `far` and place them next to each other, silently dropping the
      // detour back through `near` in between.
      const res = await request(app).get(
        `/api/wayfinding/route?from=${entrance.id}&to=${far.id}&to=${near.id}&to=${far.id}`
      );
      expect(res.status).toBe(200);
      const route = res.body.data.route;
      expect(route.legs.map((leg) => leg.toNodeId)).toEqual([far.id, near.id, far.id]);
      expect(route.stops.map((s) => s.nodeId)).toEqual([far.id, near.id, far.id]);
    });
  });

  test('evacuation route finds nearest exit', async () => {
    const { entrance, exit1 } = await seedMall();
    const res = await request(app).get(`/api/wayfinding/evacuate?from=${entrance.id}`);
    expect(res.status).toBe(200);
    const route = res.body.data.route;
    expect(route.mode).toBe('EVACUATION');
    expect(route.destination.nodeId).toBe(exit1.id);
    expect(route.segments).toHaveLength(1);
    // One exit in the building: nothing to offer, but the field is always
    // present so the client never has to branch on undefined.
    expect(route.alternatives).toEqual([]);
  });

  test('/evacuate offers two alternative exits, different doors, ordered by durationSec', async () => {
    const { building } = await createOwnerWithBuilding();
    const f1 = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 10 });
    const entrance = await createNode(building.id, f1.id, { x: 0, y: 0, type: 'NORMAL' });
    // Three doors at increasing walking distance from the same spot.
    const near = await createNode(building.id, f1.id, {
      x: 100, y: 0, type: 'EMERGENCY_EXIT', label: 'North exit',
    });
    const mid = await createNode(building.id, f1.id, {
      x: 300, y: 0, type: 'EMERGENCY_EXIT', label: 'East exit',
    });
    const far = await createNode(building.id, f1.id, {
      x: 600, y: 0, type: 'EMERGENCY_EXIT', label: 'South exit',
    });
    await connectNodes(entrance, near);
    await connectNodes(entrance, mid);
    await connectNodes(entrance, far);

    const res = await request(app).get(`/api/wayfinding/evacuate?from=${entrance.id}`);
    expect(res.status).toBe(200);
    const route = res.body.data.route;
    expect(route.destination.nodeId).toBe(near.id);

    const alternatives = route.alternatives;
    expect(alternatives).toHaveLength(2);
    // Different doors, and never the one the primary route already leads to.
    expect(alternatives.map((a) => a.exitNodeId)).toEqual([mid.id, far.id]);
    expect(alternatives[0].durationSec).toBeLessThan(alternatives[1].durationSec);
    expect(alternatives[0].label).toBe('East exit');
    expect(alternatives[0].floorNumber).toBe(1);
    expect(alternatives[0].distanceM).toBe(30);
    expect(alternatives[0].route.destination.nodeId).toBe(mid.id);
    // Lean: the hand-drawn plan is not repeated once per alternative.
    for (const alt of alternatives) {
      for (const segment of alt.route.segments) {
        expect(Object.hasOwn(segment.floor, 'drawing')).toBe(false);
      }
    }
    // …while the primary route keeps it.
    expect(Object.hasOwn(route.segments[0].floor, 'drawing')).toBe(true);
  });

  test('profile=min_floor_changes prefers a same-floor exit over an upstairs one, keeping emergency visibility', async () => {
    const { building } = await createOwnerWithBuilding();
    const f1 = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 10 });
    const f2 = await createFloor(building.id, { floorNumber: 2, scalePixelsPerMeter: 10 });
    const entrance = await createNode(building.id, f1.id, { x: 0, y: 0, type: 'NORMAL' });
    // Far on the same floor: a long walk, but no floor change.
    const exitSameFloor = await createNode(building.id, f1.id, {
      x: 700, y: 0, type: 'EMERGENCY_EXIT',
    });
    const stairsBottom = await createNode(building.id, f1.id, { x: 5, y: 0, type: 'TRANSIT' });
    const stairsTop = await createNode(building.id, f2.id, { x: 5, y: 0, type: 'TRANSIT' });
    // Right by the stairs upstairs: a short walk, but one floor change.
    const exitUpstairs = await createNode(building.id, f2.id, {
      x: 10, y: 0, type: 'EMERGENCY_EXIT',
    });
    const sameFloorEdge = await connectNodes(entrance, exitSameFloor);
    // Only reachable via an EMERGENCY_ONLY edge — proves that layering
    // min_floor_changes' cost preference on top of /evacuate did not cost it
    // the emergency profile's visibility rule.
    await prisma.edge.update({
      where: { id: sameFloorEdge.id },
      data: { visibility: 'EMERGENCY_ONLY' },
    });
    await connectNodes(entrance, stairsBottom);
    await connectNodes(stairsBottom, stairsTop, { transitType: 'STAIRS' });
    await connectNodes(stairsTop, exitUpstairs);

    // Default (time-priced) evacuation: the short upstairs detour wins.
    const fast = await request(app).get(`/api/wayfinding/evacuate?from=${entrance.id}`);
    expect(fast.status).toBe(200);
    expect(fast.body.data.route.destination.nodeId).toBe(exitUpstairs.id);

    // min_floor_changes' 600s penalty flips the preference to the long,
    // same-floor walk — which is only reachable at all because /evacuate
    // kept the emergency profile's EMERGENCY_ONLY visibility.
    const slow = await request(app).get(
      `/api/wayfinding/evacuate?from=${entrance.id}&profile=min_floor_changes`
    );
    expect(slow.status).toBe(200);
    expect(slow.body.data.route.destination.nodeId).toBe(exitSameFloor.id);
    // `profile` stays inside the closed RouteProfile union the frontend
    // switches on (its emergency banner keys off `profile === 'emergency'`);
    // the layered cost preference rides the separate, additive `preference`.
    expect(slow.body.data.route.profile).toBe('emergency');
    expect(slow.body.data.route.preference).toBe('min_floor_changes');
  });

  test('/evacuate?profile=walk keeps emergency visibility and elevator blocking', async () => {
    const { building } = await createOwnerWithBuilding();
    const f1 = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 10 });
    const f2 = await createFloor(building.id, { floorNumber: 2, scalePixelsPerMeter: 10 });
    const entrance = await createNode(building.id, f1.id, { x: 0, y: 0, type: 'NORMAL' });

    // Only reachable via an EMERGENCY_ONLY edge — invisible to ordinary
    // wayfinding, visible only under the emergency profile.
    const emergencyExit = await createNode(building.id, f1.id, {
      x: 500, y: 0, type: 'EMERGENCY_EXIT',
    });
    const emergencyEdge = await connectNodes(entrance, emergencyExit);
    await prisma.edge.update({
      where: { id: emergencyEdge.id },
      data: { visibility: 'EMERGENCY_ONLY' },
    });

    // Reachable via a fast elevator — the shortest route by raw time, but
    // elevators must stay off-limits during an evacuation regardless of any
    // explicit `profile=` the caller asks for.
    const liftBottom = await createNode(building.id, f1.id, { x: 5, y: 0, type: 'TRANSIT' });
    const liftTop = await createNode(building.id, f2.id, { x: 5, y: 0, type: 'TRANSIT' });
    const liftExit = await createNode(building.id, f2.id, { x: 10, y: 0, type: 'EMERGENCY_EXIT' });
    await connectNodes(entrance, liftBottom);
    await connectNodes(liftBottom, liftTop, { transitType: 'ELEVATOR' });
    await connectNodes(liftTop, liftExit);

    const plain = await request(app).get(`/api/wayfinding/evacuate?from=${entrance.id}`);
    expect(plain.status).toBe(200);
    expect(plain.body.data.route.destination.nodeId).toBe(emergencyExit.id);
    expect(plain.body.data.route.profile).toBe('emergency');
    expect(plain.body.data.route.preference).toBeNull();

    // A public, anonymous `profile=walk` request must not unhide the
    // EMERGENCY_ONLY edge's opposite (a plain walk profile has no such
    // effect here) nor unblock the elevator — it must reach the exact same
    // exit as the request with no profile at all. `profile` stays
    // `'emergency'` (the closed union the frontend's danger framing keys
    // off); the requested preference rides the separate `preference` field.
    const withWalk = await request(app).get(
      `/api/wayfinding/evacuate?from=${entrance.id}&profile=walk`
    );
    expect(withWalk.status).toBe(200);
    expect(withWalk.body.data.route.destination.nodeId).toBe(emergencyExit.id);
    expect(withWalk.body.data.route.profile).toBe('emergency');
    expect(withWalk.body.data.route.preference).toBe('walk');
  });

  test('/evacuate?accessible=true&excludeTags=service relaxes tags before ever dropping accessibility', async () => {
    const { building } = await createOwnerWithBuilding();
    const f1 = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 10 });
    const entrance = await createNode(building.id, f1.id, { x: 0, y: 0, type: 'NORMAL' });
    const exit = await createNode(building.id, f1.id, { x: 100, y: 0, type: 'EMERGENCY_EXIT' });
    // The only path: step-free, but tagged 'service'. Excluding the tag
    // must still find it once tags relax — accessibility must never be
    // dropped when it wasn't necessary to drop it.
    await connectNodes(entrance, exit, { tags: ['service'], accessible: true });

    const res = await request(app).get(
      `/api/wayfinding/evacuate?from=${entrance.id}&accessible=true&excludeTags=service`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.route.tagConstraintsRelaxed).toBe(true);
    expect(res.body.data.route.accessibleRouteUnavailable).toBe(false);
  });

  test('/evacuate?accessible=true&excludeTags=service drops accessibility only as an absolute last resort', async () => {
    const { building } = await createOwnerWithBuilding();
    const f1 = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 10 });
    const entrance = await createNode(building.id, f1.id, { x: 0, y: 0, type: 'NORMAL' });
    const exit = await createNode(building.id, f1.id, { x: 100, y: 0, type: 'EMERGENCY_EXIT' });
    // The only path: tagged 'service' AND not step-free. Relaxing tags
    // alone is not enough, so accessibility must be dropped too, and both
    // flags must say so — the route did in fact traverse a non-accessible,
    // tag-excluded edge to get here.
    await connectNodes(entrance, exit, { tags: ['service'], accessible: false });

    const res = await request(app).get(
      `/api/wayfinding/evacuate?from=${entrance.id}&accessible=true&excludeTags=service`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.route.accessibleRouteUnavailable).toBe(true);
    expect(res.body.data.route.tagConstraintsRelaxed).toBe(true);
  });

  test('an EMERGENCY_ONLY edge is invisible to profile=walk but usable by /evacuate', async () => {
    const { entrance, exit1 } = await seedMall();
    const edge = await prisma.edge.findFirst({
      where: {
        OR: [
          { sourceNodeId: entrance.id, targetNodeId: exit1.id },
          { sourceNodeId: exit1.id, targetNodeId: entrance.id },
        ],
      },
    });
    await prisma.edge.update({ where: { id: edge.id }, data: { visibility: 'EMERGENCY_ONLY' } });

    // The only edge to exit1 is now hidden from ordinary wayfinding.
    const walkAttempt = await request(app).get(
      `/api/wayfinding/route?from=${entrance.id}&to=${exit1.id}`
    );
    expect(walkAttempt.status).toBe(404);

    // /evacuate's emergency profile can still see it.
    const evac = await request(app).get(`/api/wayfinding/evacuate?from=${entrance.id}`);
    expect(evac.status).toBe(200);
    expect(evac.body.data.route.destination.nodeId).toBe(exit1.id);
  });
});

/** Fetch and solve an arming challenge — the human check on the switch. */
const solvedChallenge = async (cookie) => {
  const res = await request(app).get('/api/emergency/challenge').set('Cookie', cookie);
  const { token, question } = res.body.data;
  const [a, b] = question.split(' + ').map(Number);
  return { token, answer: a + b };
};

describe('emergency v2 API', () => {
  test('trigger/resolve are idempotent and permission-gated', async () => {
    const { cookie, building, roles } = await createOwnerWithBuilding();

    // No challenge → refused before anything arms. 428 tells the client this
    // is a missing step, not a permissions problem.
    const bare = await request(app)
      .post(`/api/emergency/buildings/${building.id}/trigger`)
      .set('Cookie', cookie)
      .send({ message: 'Fire on floor 2' });
    expect(bare.status).toBe(428);

    // Wrong answer → refused.
    const wrong = await request(app)
      .post(`/api/emergency/buildings/${building.id}/trigger`)
      .set('Cookie', cookie)
      .send({ message: 'x', challenge: { ...(await solvedChallenge(cookie)), answer: -1 } });
    expect(wrong.status).toBe(403);

    const trigger = await request(app)
      .post(`/api/emergency/buildings/${building.id}/trigger`)
      .set('Cookie', cookie)
      .send({ message: 'Fire on floor 2', challenge: await solvedChallenge(cookie) });
    expect(trigger.status).toBe(200);
    expect(trigger.body.data.alreadyActive).toBe(false);
    const emergencyId = trigger.body.data.emergencyId;
    expect(emergencyId).toBeTruthy();

    const again = await request(app)
      .post(`/api/emergency/buildings/${building.id}/trigger`)
      .set('Cookie', cookie)
      .send({ challenge: await solvedChallenge(cookie) });
    expect(again.body.data.alreadyActive).toBe(true);
    expect(again.body.data.emergencyId).toBe(emergencyId);

    // Public status
    const status = await request(app).get(
      `/api/emergency/buildings/${building.id}/status`
    );
    expect(status.body.data).toMatchObject({
      isEmergency: true,
      message: 'Fire on floor 2',
      emergencyId,
    });

    // Viewer cannot trigger/resolve
    const viewer = await createUser();
    await addMember(building.id, viewer.user.id, roles['Viewer'].id);
    const denied = await request(app)
      .post(`/api/emergency/buildings/${building.id}/resolve`)
      .set('Cookie', viewer.cookie)
      .send({ challenge: await solvedChallenge(viewer.cookie) });
    expect(denied.status).toBe(403);

    // Security Officer can resolve
    const officer = await createUser();
    await addMember(building.id, officer.user.id, roles['Security Officer'].id);
    const resolve = await request(app)
      .post(`/api/emergency/buildings/${building.id}/resolve`)
      .set('Cookie', officer.cookie)
      .send({ challenge: await solvedChallenge(officer.cookie) });
    expect(resolve.status).toBe(200);
    expect(resolve.body.data.alreadyResolved).toBe(false);

    const event = await prisma.emergencyEvent.findUnique({ where: { id: emergencyId } });
    expect(event.status).toBe('RESOLVED');
    expect(event.endedAt).toBeTruthy();

    const after = await request(app).get(
      `/api/emergency/buildings/${building.id}/status`
    );
    expect(after.body.data.isEmergency).toBe(false);
    expect(after.body.data.message).toBeNull();
  });

  test('anonymous evacuated/called actions count on the open event (incl. legacy aliases)', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    await request(app)
      .post(`/api/emergency/buildings/${building.id}/trigger`)
      .set('Cookie', cookie)
      .send({ challenge: await solvedChallenge(cookie) });

    const evac = await request(app).post(
      `/api/emergency/buildings/${building.id}/evacuated`
    );
    expect(evac.status).toBe(200);

    // Legacy alias with body-supplied buildingId
    const legacy = await request(app)
      .post('/api/building/evacuated')
      .send({ buildingId: building.id });
    expect(legacy.status).toBe(200);

    const called = await request(app)
      .post('/api/building/emergencyCall')
      .send({ buildingId: building.id });
    expect(called.status).toBe(200);

    const event = await prisma.emergencyEvent.findFirst({
      where: { buildingId: building.id, status: 'ACTIVE' },
    });
    expect(event.evacuated).toBe(2);
    expect(event.calledEmergency).toBe(1);
  });
});
