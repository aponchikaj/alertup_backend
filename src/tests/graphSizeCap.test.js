import request from 'supertest';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import { MAX_NODES } from '../features/wayfinding/dijkstra.js';
import { loadBuildingGraph, GraphTooLargeError } from '../features/wayfinding/graphService.js';
import { createOwnerWithBuilding, createFloor } from './helpers.js';

// FX-093: the graph loader took the first MAX_NODES nodes in no particular
// order. Past the cap, routing ran on an arbitrary subset that could be
// missing the exits. A building now cannot grow past the cap, and the loader
// refuses loudly instead of routing on a partial graph.

async function fill(buildingId, floorId, count) {
  const data = Array.from({ length: count }, (_, i) => ({ buildingId, floorId, x: i, y: 0, type: 'NORMAL' }));
  for (let i = 0; i < data.length; i += 5000) {
    await prisma.node.createMany({ data: data.slice(i, i + 5000) });
  }
}

test('the editor refuses a node past the per-building cap', async () => {
  const { building, cookie } = await createOwnerWithBuilding();
  const floor = await createFloor(building.id);
  await fill(building.id, floor.id, MAX_NODES);

  const res = await request(app)
    .post(`/api/map-editor/floors/${floor.id}/nodes`)
    .set('Cookie', cookie)
    .send({ x: 1, y: 1 });
  expect(res.status).toBe(422);
  expect(res.body.message).toMatch(/limit/i);
  expect(await prisma.node.count({ where: { buildingId: building.id } })).toBe(MAX_NODES);
}, 60_000);

test('the loader refuses an over-cap graph instead of truncating it', async () => {
  const { building } = await createOwnerWithBuilding();
  const floor = await createFloor(building.id);
  await fill(building.id, floor.id, MAX_NODES + 1);
  await expect(loadBuildingGraph(building.id)).rejects.toBeInstanceOf(GraphTooLargeError);
}, 60_000);
