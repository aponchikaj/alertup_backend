import request from 'supertest';
import app from '../../server.js';
import { createOwnerWithBuilding } from './helpers.js';

/* ============================================================================
   FX-015 / FX-085 — dead routes with live risk, removed.

   Neither the floor-map PUT nor /api/upload/* had a caller on stage or on the
   production frontend. The PUT stored a client-supplied URL as the floor map
   (later deleted from storage by prefix — another tenant's asset, SEC-01),
   skipped the floor cap, and fed that URL to the server-side AI vision fetch
   (SSRF). /api/upload/* let any signed-in user write unsanitized SVG to the
   public bucket with no rate limit or building scope.
   ========================================================================= */

test('PUT /api/building/:id/floor/:n/map no longer exists', async () => {
  const { cookie, building } = await createOwnerWithBuilding();

  const res = await request(app)
    .put(`/api/building/${building.id}/floor/1/map`)
    .set('Cookie', cookie)
    .send({ svgMapUrl: 'http://169.254.169.254/latest/meta-data/' });

  expect(res.status).toBe(404);
});

test('/api/upload/* no longer exists', async () => {
  const { cookie } = await createOwnerWithBuilding();

  const res = await request(app).post('/api/upload/svg').set('Cookie', cookie);

  expect(res.status).toBe(404);
});
