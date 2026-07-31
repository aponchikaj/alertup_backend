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
    const poi = await prisma.poi.create({
      data: {
        nodeId: shopNode.id,
        name: 'LC Waikiki',
        category: 'Apparel',
        keywords: ['clothes', 'fashion'],
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
  });

  test('accessible route falls back with a flag when only escalators exist', async () => {
    const { entrance, poi } = await seedMall();
    const res = await request(app).get(
      `/api/wayfinding/route?from=${entrance.id}&to=poi:${poi.id}&accessible=true`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.route.accessibleRouteUnavailable).toBe(true);
  });

  test('evacuation route finds nearest exit', async () => {
    const { entrance, exit1 } = await seedMall();
    const res = await request(app).get(`/api/wayfinding/evacuate?from=${entrance.id}`);
    expect(res.status).toBe(200);
    const route = res.body.data.route;
    expect(route.mode).toBe('EVACUATION');
    expect(route.destination.nodeId).toBe(exit1.id);
    expect(route.segments).toHaveLength(1);
  });
});

describe('emergency v2 API', () => {
  test('trigger/resolve are idempotent and permission-gated', async () => {
    const { cookie, building, roles } = await createOwnerWithBuilding();

    const trigger = await request(app)
      .post(`/api/emergency/buildings/${building.id}/trigger`)
      .set('Cookie', cookie)
      .send({ message: 'Fire on floor 2' });
    expect(trigger.status).toBe(200);
    expect(trigger.body.data.alreadyActive).toBe(false);
    const emergencyId = trigger.body.data.emergencyId;
    expect(emergencyId).toBeTruthy();

    const again = await request(app)
      .post(`/api/emergency/buildings/${building.id}/trigger`)
      .set('Cookie', cookie)
      .send({});
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
      .set('Cookie', viewer.cookie);
    expect(denied.status).toBe(403);

    // Security Officer can resolve
    const officer = await createUser();
    await addMember(building.id, officer.user.id, roles['Security Officer'].id);
    const resolve = await request(app)
      .post(`/api/emergency/buildings/${building.id}/resolve`)
      .set('Cookie', officer.cookie);
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
      .send({});

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
