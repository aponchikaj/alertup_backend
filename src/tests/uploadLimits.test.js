import request from 'supertest';
import app from '../../server.js';
import { createOwnerWithBuilding } from './helpers.js';

/* FX-048 — `upload.array('maps')` had no file-count limit. Every file (up to
   10 MB each) is buffered in memory on the single machine, so one request
   with hundreds of parts could exhaust it. */

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c6360000002000154a24f5f0000000049454e44ae426082',
  'hex'
);

test('a request with more map files than any plan allows is rejected with 400', async () => {
  const { cookie } = await createOwnerWithBuilding();
  let req = request(app).post('/api/building/new').set('Cookie', cookie).field('buildingName', 'Big Tower');
  for (let i = 0; i < 60; i++) req = req.attach('maps', PNG, `f${i}.png`);

  const res = await req;

  expect(res.status).toBe(400);
});
