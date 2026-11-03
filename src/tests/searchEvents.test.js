import request from 'supertest';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import { createOwnerWithBuilding, createFloor, createNode } from './helpers.js';
import { drain } from '../services/analyticsQueue.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Search-quality logging: what visitors typed, especially the queries that
 * found nothing (that's how an owner learns their map is missing something),
 * and which POI they eventually picked. Writes go through the analytics
 * queue (src/services/analyticsQueue.js), so every assertion on the database
 * follows an `await drain()`.
 */
describe('search events', () => {
  async function seedBuildingWithPoi() {
    const seeded = await createOwnerWithBuilding();
    const floor = await createFloor(seeded.building.id, { floorNumber: 1 });
    const node = await createNode(seeded.building.id, floor.id, { type: 'POI' });
    const poi = await prisma.poi.create({
      data: { nodeId: node.id, buildingId: seeded.building.id, name: 'Test Cafe' },
    });
    return { ...seeded, floor, node, poi };
  }

  test('a query with zero results is logged once the queue drains', async () => {
    const { building } = await seedBuildingWithPoi();

    const res = await request(app).get(
      `/api/wayfinding/buildings/${building.id}/pois?q=nonexistentzzz`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.pois).toHaveLength(0);
    const { searchId } = res.body.data;
    expect(searchId).toMatch(UUID_RE);

    await drain();

    const stored = await prisma.searchEvent.findUnique({ where: { id: searchId } });
    expect(stored).toMatchObject({
      buildingId: building.id,
      query: 'nonexistentzzz',
      resultCount: 0,
      pickedPoiId: null,
    });
  });

  test('a query that matches something is logged with its result count', async () => {
    const { building } = await seedBuildingWithPoi();

    const res = await request(app).get(`/api/wayfinding/buildings/${building.id}/pois?q=cafe`);
    expect(res.status).toBe(200);
    expect(res.body.data.pois).toHaveLength(1);
    const { searchId } = res.body.data;

    await drain();

    const stored = await prisma.searchEvent.findUnique({ where: { id: searchId } });
    expect(stored).toMatchObject({ buildingId: building.id, query: 'cafe', resultCount: 1 });
  });

  test('a blank query (browsing) is never logged', async () => {
    const { building } = await seedBuildingWithPoi();

    const res = await request(app).get(`/api/wayfinding/buildings/${building.id}/pois`);
    expect(res.status).toBe(200);

    await drain();

    const count = await prisma.searchEvent.count({ where: { buildingId: building.id } });
    expect(count).toBe(0);
  });

  test('picking a POI is scoped to the building that owns the search — a POI from another building cannot claim it', async () => {
    const { building, poi } = await seedBuildingWithPoi();
    const other = await createOwnerWithBuilding();
    const otherFloor = await createFloor(other.building.id, { floorNumber: 1 });
    const otherNode = await createNode(other.building.id, otherFloor.id, { type: 'POI' });
    const otherPoi = await prisma.poi.create({
      data: { nodeId: otherNode.id, buildingId: other.building.id, name: 'Other Building Shop' },
    });

    const search = await request(app).get(`/api/wayfinding/buildings/${building.id}/pois?q=cafe`);
    const { searchId } = search.body.data;
    await drain();

    // A POI from a different building must not be able to write to this
    // search event, even though the searchId itself is valid.
    const crossBuilding = await request(app)
      .post(`/api/wayfinding/search-events/${searchId}/pick`)
      .send({ poiId: otherPoi.id });
    expect(crossBuilding.status).toBe(404);

    let stored = await prisma.searchEvent.findUnique({ where: { id: searchId } });
    expect(stored.pickedPoiId).toBeNull();

    // The POI that actually belongs to the search's building succeeds.
    const sameBuilding = await request(app)
      .post(`/api/wayfinding/search-events/${searchId}/pick`)
      .send({ poiId: poi.id });
    expect(sameBuilding.status).toBe(200);

    stored = await prisma.searchEvent.findUnique({ where: { id: searchId } });
    expect(stored.pickedPoiId).toBe(poi.id);
  });

  test('picking against an unknown searchId is a 404, not a 500', async () => {
    const { poi } = await seedBuildingWithPoi();
    const res = await request(app)
      .post(`/api/wayfinding/search-events/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}/pick`)
      .send({ poiId: poi.id });
    expect(res.status).toBe(404);
  });

  test('a malformed searchId is rejected before touching the database', async () => {
    const { poi } = await seedBuildingWithPoi();
    const res = await request(app)
      .post('/api/wayfinding/search-events/not-a-uuid/pick')
      .send({ poiId: poi.id });
    expect(res.status).toBe(400);
  });

  test('a malformed poiId is rejected with 400', async () => {
    const res = await request(app)
      .post(`/api/wayfinding/search-events/${'1'.repeat(8)}-1111-1111-1111-${'1'.repeat(12)}/pick`)
      .send({ poiId: 'not-an-id' });
    expect(res.status).toBe(400);
  });
});
