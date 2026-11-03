import prisma from '../db/prisma.js';
import { createOwnerWithBuilding, createFloor, createNode } from './helpers.js';

/* ============================================================================
   FX-071 — building consistency the database enforces itself.

   Poi.buildingId was a hand-maintained copy of its node's building (NULL for
   any row written outside the map editor), and "an edge's nodes, a node's
   floor, all in one building" was enforced only in application code. Triggers
   now fill Poi.buildingId from its node and refuse cross-building edges and
   nodes, whatever path writes them.
   ========================================================================= */

test('a POI written without buildingId gets its node\'s building', async () => {
  const { building } = await createOwnerWithBuilding();
  const floor = await createFloor(building.id, { floorNumber: 1 });
  const node = await createNode(building.id, floor.id);

  const poi = await prisma.poi.create({ data: { nodeId: node.id, name: 'Kiosk' } });

  expect(poi.buildingId).toBe(building.id);
});

test('a POI cannot claim another building', async () => {
  const { building } = await createOwnerWithBuilding();
  const { building: other } = await createOwnerWithBuilding();
  const floor = await createFloor(building.id, { floorNumber: 1 });
  const node = await createNode(building.id, floor.id);

  const poi = await prisma.poi.create({ data: { nodeId: node.id, name: 'Kiosk', buildingId: other.id } });

  expect(poi.buildingId).toBe(building.id);
});

test('an edge between nodes of another building is refused', async () => {
  const { building: a } = await createOwnerWithBuilding();
  const { building: b } = await createOwnerWithBuilding();
  const floorA = await createFloor(a.id, { floorNumber: 1 });
  const floorB = await createFloor(b.id, { floorNumber: 1 });
  const nA = await createNode(a.id, floorA.id);
  const nB = await createNode(b.id, floorB.id);

  await expect(
    prisma.edge.create({
      data: { sourceNodeId: nA.id, targetNodeId: nB.id, buildingId: a.id, distance: 1, weight: 1 },
    })
  ).rejects.toThrow(/different building/i);
});

test('a node on another building\'s floor is refused', async () => {
  const { building: a } = await createOwnerWithBuilding();
  const { building: b } = await createOwnerWithBuilding();
  const floorB = await createFloor(b.id, { floorNumber: 1 });

  await expect(
    createNode(a.id, floorB.id)
  ).rejects.toThrow(/different building/i);
});
