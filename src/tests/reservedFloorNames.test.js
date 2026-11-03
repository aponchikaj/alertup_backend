import request from 'supertest';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import { createUser, createOwnerWithBuilding, createFloor } from './helpers.js';

// FX-095: a floor's printed QR code opens /building/<buildingId>/<floorName>,
// a URL that cannot change (stickers are already on walls). The app also has
// static pages at /building/<buildingId>/nodes|members|logs|analytics, which
// win the route match, so a floor with one of those names could never be
// reached from its QR code. Those names are now refused wherever a floor is
// named.

test('building create refuses a floor named like a building page', async () => {
  const { cookie, user } = await createUser({ plan: 'BUSINESS' });
  const res = await request(app)
    .post('/api/building/new')
    .set('Cookie', cookie)
    .send({ buildingName: 'Reserved Tower', floorNames: ['Ground', 'Logs'] });
  expect(res.body.success).toBe(false);
  expect(res.body.message).toMatch(/reserved/i);
  expect(await prisma.building.count({ where: { ownerId: user.id } })).toBe(0);
});

test('the editor refuses a reserved name on create and on rename', async () => {
  const { cookie, building } = await createOwnerWithBuilding();
  const created = await request(app)
    .post(`/api/map-editor/buildings/${building.id}/floors`)
    .set('Cookie', cookie)
    .send({ floorNumber: 1, name: 'members' });
  expect(created.status).toBe(422);

  const floor = await createFloor(building.id, { floorNumber: 2, name: 'Second' });
  const renamed = await request(app)
    .patch(`/api/map-editor/floors/${floor.id}`)
    .set('Cookie', cookie)
    .send({ name: ' Analytics ' });
  expect(renamed.status).toBe(422);
  expect((await prisma.floor.findUnique({ where: { id: floor.id } })).name).toBe('Second');
});
