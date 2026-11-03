import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import { createOwnerWithBuilding, createFloor } from './helpers.js';

// FX-093: the legacy building reads (landing page, "my buildings", floor QR
// view) use five Floor columns but loaded whole rows, including svgContent
// and drawing, the two largest columns in the database. Every Floor read on
// these routes must select its columns.

function floorReadsWithoutSelect(calls) {
  const bad = [];
  const visit = (node, where) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'floors' && (value === true || (typeof value === 'object' && !value.select))) bad.push(where);
      if (typeof value === 'object') visit(value, where);
    }
  };
  for (const [model, args] of calls) {
    if (model === 'floor.update' && !args?.select) bad.push(model);
    else visit(args, model);
  }
  return bad;
}

let calls;
let spies;
beforeEach(() => {
  calls = [];
  const wrap = (delegate, method, label) => {
    const real = delegate[method].bind(delegate);
    return jest.spyOn(delegate, method).mockImplementation((args) => {
      calls.push([label, args]);
      return real(args);
    });
  };
  spies = [
    wrap(prisma.building, 'findUnique', 'building.findUnique'),
    wrap(prisma.building, 'findMany', 'building.findMany'),
    wrap(prisma.buildingMember, 'findMany', 'buildingMember.findMany'),
    wrap(prisma.floor, 'update', 'floor.update'),
  ];
});
afterEach(() => spies.forEach((s) => s.mockRestore()));

test('landing page, my buildings and floor QR view never load whole Floor rows', async () => {
  const { building, cookie } = await createOwnerWithBuilding();
  await createFloor(building.id, { floorNumber: 1, name: 'Ground', svgContent: '<svg/>' });

  expect((await request(app).get(`/api/building/id/${building.id}`)).status).toBe(200);
  expect((await request(app).get('/api/building/my').set('Cookie', cookie)).status).toBe(200);
  const scan = await request(app).get(`/api/building/scan/${building.id}/Ground`);
  expect(scan.status).toBe(200);
  expect(scan.body.data.floorData).toMatchObject({ floor: 'Ground', scanned: 1 });

  expect(calls.length).toBeGreaterThan(0);
  expect(floorReadsWithoutSelect(calls)).toEqual([]);
});
