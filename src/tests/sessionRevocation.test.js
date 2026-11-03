import request from 'supertest';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import { signSessionToken } from '../utils/session.js';
import { sweepOnce } from '../jobs/sweeper.js';
import { createUser, createOwnerWithBuilding, createFloor, createNode, connectNodes, qrIdFor } from './helpers.js';

// FX-083: logout used to clear the cookie only; the JWT itself stayed valid for
// its full 7 days (and the Safari/iOS fallback keeps a copy in localStorage).
// Logout now revokes that one token by its jti; other devices stay signed in.
// FX-087: scan attribution decoded tokens itself and so ignored both revocation
// and tokenVersion bumps (password change/reset). It now uses the same check.

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

test('logout revokes the token it was called with', async () => {
  const { user } = await createUser();
  const token = signSessionToken(user);

  expect((await request(app).get('/api/settings').set(bearer(token))).status).toBe(200);
  expect((await request(app).post('/api/settings/logout').set(bearer(token))).status).toBe(200);
  expect((await request(app).get('/api/settings').set(bearer(token))).status).toBe(401);
});

test('logging out one device leaves the other signed in', async () => {
  const { user } = await createUser();
  const phone = signSessionToken(user);
  const laptop = signSessionToken(user);
  expect(phone).not.toBe(laptop);

  await request(app).post('/api/settings/logout').set(bearer(phone));
  expect((await request(app).get('/api/settings').set(bearer(laptop))).status).toBe(200);
});

async function scanAs(cookieToken) {
  const { building } = await createOwnerWithBuilding();
  const floor = await createFloor(building.id, { floorNumber: 1 });
  const node = await createNode(building.id, floor.id, { x: 0, y: 0, type: 'NORMAL' });
  const exit = await createNode(building.id, floor.id, { x: 50, y: 0, type: 'EMERGENCY_EXIT' });
  await connectNodes(node, exit);
  const res = await request(app)
    .get(`/api/qr/scan/route/${qrIdFor(node, 1)}`)
    .set('Cookie', [`userToken=${cookieToken}`]);
  expect(res.status).toBe(200);
}

test('scan history is not attributed to a logged-out token', async () => {
  const { user } = await createUser();
  const token = signSessionToken(user);
  await request(app).post('/api/settings/logout').set(bearer(token));
  await scanAs(token);
  expect(await prisma.scanEvent.count({ where: { userId: user.id } })).toBe(0);
});

test('scan history is not attributed to a token from before a password change', async () => {
  const { user } = await createUser();
  const token = signSessionToken(user);
  await prisma.user.update({ where: { id: user.id }, data: { tokenVersion: { increment: 1 } } });
  await scanAs(token);
  expect(await prisma.scanEvent.count({ where: { userId: user.id } })).toBe(0);
});

test('the sweeper drops revocations whose token has expired anyway', async () => {
  await prisma.revokedToken.createMany({
    data: [
      { jti: 'old', expiresAt: new Date(Date.now() - 1000) },
      { jti: 'live', expiresAt: new Date(Date.now() + 60_000) },
    ],
  });
  await sweepOnce();
  expect((await prisma.revokedToken.findMany()).map((r) => r.jti)).toEqual(['live']);
});
