import request from 'supertest';
import app from '../../server.js';
import { createOwnerWithBuilding } from './helpers.js';

/* ============================================================================
   FX-042 — the AI concierge's per-minute and daily caps are per building+IP.

   They were keyed by IP alone and shared by every AI route, so everyone on a
   building's Wi-Fi (or behind carrier NAT) shared ONE allowance across every
   building, and asking in building A used up building B's. Each building now
   has its own allowance per client address.
   ========================================================================= */

const ask = (ip, buildingId) =>
  request(app)
    .post('/api/ai/chat')
    .set('X-Forwarded-For', ip)
    .send({ buildingId, messages: [{ role: 'user', content: 'where is the exit?' }], locale: 'en' });

test('exhausting the cap in one building leaves another building\'s cap untouched', async () => {
  const { building: a } = await createOwnerWithBuilding();
  const { building: b } = await createOwnerWithBuilding();
  const ip = '10.123.45.67';

  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await ask(ip, a.id)).status);
  const other = await ask(ip, b.id);

  expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
  expect(statuses[10]).toBe(429);
  expect(other.status).not.toBe(429);
});
