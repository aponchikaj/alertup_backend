import request from 'supertest';
import app from '../../server.js';
import { findUnsafeSvgContent } from '../services/svgSafety.js';
import { svgDisposition } from '../services/storage.js';
import { createOwnerWithBuilding } from './helpers.js';

/* ============================================================================
   FX-040 — uploaded SVGs cannot carry script.

   Floor plans and logos are stored on the public asset host; an SVG opened
   directly from there runs its scripts on that origin. Uploads with
   script-capable content are refused (422) rather than regex-"cleaned", and
   every stored SVG is served as an attachment so a direct visit downloads it.
   ========================================================================= */

const SAFE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#0284C7"/></svg>';

describe('findUnsafeSvgContent', () => {
  test('a plain drawing is fine', () => {
    expect(findUnsafeSvgContent(SAFE)).toBeNull();
  });

  test.each([
    ['<svg><script>alert(1)</script></svg>', 'script'],
    ['<svg><SCRIPT >x</SCRIPT></svg>', 'script'],
    ['<svg><rect onload="alert(1)"/></svg>', 'event-handler'],
    ['<svg><a href="javascript:alert(1)">x</a></svg>', 'javascript:'],
    ['<svg><a xlink:href=" JavaScript :alert(1)">x</a></svg>', 'javascript:'],
    ['<svg><foreignObject><div/></foreignObject></svg>', 'foreignObject'],
    ['<svg><iframe src="x"/></svg>', 'embedded'],
    ['<svg><image href="data:text/html,x"/></svg>', 'data:'],
    ['<!DOCTYPE svg [<!ENTITY x "y">]><svg/>', 'entity'],
  ])('refuses %s', (svg, word) => {
    expect(findUnsafeSvgContent(svg)).toMatch(new RegExp(word, 'i'));
  });
});

test('stored SVGs are served as attachments; other images are not', () => {
  expect(svgDisposition('image/svg+xml')).toEqual({ ContentDisposition: 'attachment' });
  expect(svgDisposition('image/png')).toEqual({});
});

describe('POST /api/map-editor/buildings/:id/logos', () => {
  const upload = (cookie, buildingId, svg) =>
    request(app)
      .post(`/api/map-editor/buildings/${buildingId}/logos`)
      .set('Cookie', cookie)
      .attach('logo', Buffer.from(svg), { filename: 'logo.svg', contentType: 'image/svg+xml' });

  test('refuses an SVG that carries script', async () => {
    const { cookie, building } = await createOwnerWithBuilding();

    const res = await upload(cookie, building.id, '<svg><script>alert(document.cookie)</script></svg>');

    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/script/);
  });

  test('accepts a plain SVG logo', async () => {
    const { cookie, building } = await createOwnerWithBuilding();

    const res = await upload(cookie, building.id, SAFE);

    expect(res.status).toBe(201);
  });
});
