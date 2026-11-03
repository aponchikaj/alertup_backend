import request from 'supertest';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import { drain } from '../services/analyticsQueue.js';
import { createOwnerWithBuilding, createFloor, createNode } from './helpers.js';

// BE-29: the public directory and POI search listed every labelled point,
// including STAFF and EMERGENCY_ONLY ones that public routing can't reach.
// BE-34: the search `q` had no length cap and was stored verbatim.

async function seed() {
  const { building } = await createOwnerWithBuilding();
  const floor = await createFloor(building.id, { floorNumber: 1 });
  const lobby = await createNode(building.id, floor.id, { x: 0, y: 0, label: 'Lobby Cafe' });
  const staff = await createNode(building.id, floor.id, { x: 10, y: 0, label: 'Server Room', visibility: 'STAFF' });
  const muster = await createNode(building.id, floor.id, { x: 20, y: 0, label: 'Muster Point', visibility: 'EMERGENCY_ONLY' });
  await prisma.poi.create({ data: { nodeId: lobby.id, buildingId: building.id, name: 'Cafe Aroma', searchText: 'cafe aroma' } });
  await prisma.poi.create({ data: { nodeId: staff.id, buildingId: building.id, name: 'Cafe Staff Kitchen', searchText: 'cafe staff kitchen' } });
  await prisma.poi.create({ data: { nodeId: muster.id, buildingId: building.id, name: 'Cafe Muster', searchText: 'cafe muster' } });
  return building;
}

test('the directory lists only PUBLIC points', async () => {
  const building = await seed();
  const res = await request(app).get(`/api/wayfinding/buildings/${building.id}/directory`);
  expect(res.status).toBe(200);
  const names = JSON.stringify(res.body);
  expect(names).toContain('Cafe Aroma');
  expect(names).not.toMatch(/Server Room|Staff Kitchen|Muster/);
});

test('POI search finds only PUBLIC points', async () => {
  const building = await seed();
  const res = await request(app).get(`/api/wayfinding/buildings/${building.id}/pois?q=cafe`);
  expect(res.status).toBe(200);
  expect(res.body.data.pois.map((p) => p.name)).toEqual(['Cafe Aroma']);
});

test('a long search query is capped at 100 characters before it is matched or stored', async () => {
  const building = await seed();
  const q = 'cafe' + 'x'.repeat(500);
  const res = await request(app).get(`/api/wayfinding/buildings/${building.id}/pois?q=${q}`);
  expect(res.status).toBe(200);
  await drain();
  const [event] = await prisma.searchEvent.findMany({ where: { buildingId: building.id } });
  expect(event.query.length).toBe(100);
});
