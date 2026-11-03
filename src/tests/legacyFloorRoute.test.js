import request from 'supertest';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import { createUser, createBuilding, createFloor } from './helpers.js';

/* ============================================================================
   FX-017 — a public, anonymous GET must never write.

   GET /api/route/building/:id/floor/:n used to upsert a placeholder floor for
   any floor number it was asked about, so anyone could add floors 0..∞ to any
   building (and walk past the plan's floor cap). It now only reads.
   ========================================================================= */

test('asking about a floor that does not exist creates nothing', async () => {
  const { user } = await createUser();
  const { building } = await createBuilding(user.id);

  const res = await request(app).get(`/api/route/building/${building.id}/floor/7`);

  expect(res.status).toBe(404);
  expect(await prisma.floor.count({ where: { buildingId: building.id } })).toBe(0);
});

test('an existing floor with a map is still served', async () => {
  const { user } = await createUser();
  const { building } = await createBuilding(user.id);
  await createFloor(building.id, { floorNumber: 2, svgContent: '<svg/>' });

  const res = await request(app).get(`/api/route/building/${building.id}/floor/2`);

  expect(res.status).toBe(200);
  expect(res.body.svgContent).toBe('<svg/>');
});
