import request from 'supertest';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import { createOwnerWithBuilding, createFloor, createNode, connectNodes, qrIdFor } from './helpers.js';

/* FX-055 — deactivating a building tells the owner "its codes will stop
   resolving", and the floor-QR scan honours that (410). The node-QR scan did
   not: a deactivated building kept serving routes and stale evacuation data. */

test('a node QR in a deactivated building returns 410', async () => {
  const { building } = await createOwnerWithBuilding();
  const floor = await createFloor(building.id, { floorNumber: 1 });
  const here = await createNode(building.id, floor.id, { label: 'Lobby' });
  const exit = await createNode(building.id, floor.id, { x: 200, type: 'EMERGENCY_EXIT' });
  await connectNodes(here, exit);
  await prisma.building.update({ where: { id: building.id }, data: { isDeactivated: true } });

  const res = await request(app).get(`/api/qr/scan/route/${qrIdFor(here, floor.floorNumber)}`);

  expect(res.status).toBe(410);
});
