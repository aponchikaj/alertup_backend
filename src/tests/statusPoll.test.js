import request from 'supertest';
import app from '../../server.js';
import { createOwnerWithBuilding } from './helpers.js';
import { triggerEmergency } from '../features/emergency/emergencyService.js';

/* ============================================================================
   D15 (research 004) — the emergency status poll must survive a building's
   shared Wi-Fi.

   When a phone cannot hold a live stream it polls
   GET /api/emergency/buildings/:id/status every 10 s. That route shared the
   120/min/IP public limiter, so ~20 phones behind one NAT exhausted it and
   every one of them got 429 — no attacker needed. The poll now has its own
   NAT-sized limit, answers from a 1 s per-building cache (hundreds of phones,
   one database read) and is marked cacheable for a future CDN.
   ========================================================================= */

test('300 polls from one shared IP within a minute all succeed', async () => {
  const { building } = await createOwnerWithBuilding();

  const statuses = [];
  for (let i = 0; i < 300; i++) {
    const res = await request(app).get(`/api/emergency/buildings/${building.id}/status`);
    statuses.push(res.status);
  }

  expect(statuses.filter((s) => s !== 200)).toEqual([]);
});

test('the status is marked briefly cacheable', async () => {
  const { building } = await createOwnerWithBuilding();

  const res = await request(app).get(`/api/emergency/buildings/${building.id}/status`);

  expect(res.headers['cache-control']).toMatch(/max-age=2/);
});

test('a trigger is visible immediately, not after the cache expires', async () => {
  const { building } = await createOwnerWithBuilding();
  await request(app).get(`/api/emergency/buildings/${building.id}/status`); // warm the cache

  await triggerEmergency(building.id, { trigger: 'ADMIN' });
  const res = await request(app).get(`/api/emergency/buildings/${building.id}/status`);

  expect(res.body.data.isEmergency).toBe(true);
});
