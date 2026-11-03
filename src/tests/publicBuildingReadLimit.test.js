import request from 'supertest';
import app from '../../server.js';

// FX-088: GET /api/building/id/:id is public and unauthenticated (it backs the
// building landing page), so it shares the public-read budget (120/min/IP)
// with the scan route instead of being free to hammer.

test('GET /api/building/id/:id is rate limited like other public reads', async () => {
  const id = 'cxxxxxxxxxxxxxxxxxxxxxxxx';
  const statuses = [];
  for (let i = 0; i < 121; i++) {
    statuses.push((await request(app).get(`/api/building/id/${id}`)).status);
  }
  expect(statuses.slice(0, 120).includes(429)).toBe(false);
  expect(statuses[120]).toBe(429);
});
