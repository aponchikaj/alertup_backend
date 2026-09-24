import prisma from '../../db/prisma.js';
import { createOwnerWithBuilding, createFloor, createNode } from '../../tests/helpers.js';
import { resolveDestination, parseDestinations } from './destinations.js';

describe('parseDestinations', () => {
  test('a single string becomes a one-element array', () => {
    expect(parseDestinations({ to: 'abc' })).toEqual(['abc']);
  });

  test('an array of strings is preserved in order', () => {
    expect(parseDestinations({ to: ['a', 'b', 'c'] })).toEqual(['a', 'b', 'c']);
  });

  test('missing `to` returns an empty array', () => {
    expect(parseDestinations({})).toEqual([]);
    expect(parseDestinations()).toEqual([]);
  });

  test('adjacent repeats collapse into one', () => {
    expect(parseDestinations({ to: ['a', 'a', 'b', 'b', 'b'] })).toEqual(['a', 'b']);
  });

  test('non-adjacent repeats are preserved', () => {
    expect(parseDestinations({ to: ['a', 'b', 'a'] })).toEqual(['a', 'b', 'a']);
  });

  test('caps at 8 entries', () => {
    const many = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const result = parseDestinations({ to: many });
    expect(result).toHaveLength(8);
    expect(result).toEqual(many.slice(0, 8));
  });

  test('blank entries are dropped', () => {
    expect(parseDestinations({ to: ['', '  ', 'a'] })).toEqual(['a']);
  });
});

describe('resolveDestination', () => {
  async function seed() {
    const { building } = await createOwnerWithBuilding();
    const other = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, { floorNumber: 1 });
    const node = await createNode(building.id, floor.id, { x: 0, y: 0, type: 'NORMAL' });
    const poiNode = await createNode(building.id, floor.id, {
      x: 10,
      y: 10,
      type: 'POI',
      externalId: 'NODE-CODE',
    });
    const poi = await prisma.poi.create({
      data: {
        nodeId: poiNode.id,
        buildingId: building.id,
        name: 'Test Shop',
        category: 'Retail',
        externalId: 'SHOP-1',
      },
    });

    const otherFloor = await createFloor(other.building.id, { floorNumber: 1 });
    const otherNode = await createNode(other.building.id, otherFloor.id, {
      x: 0,
      y: 0,
      type: 'POI',
      externalId: 'SHOP-1', // same code, different building
    });
    await prisma.poi.create({
      data: {
        nodeId: otherNode.id,
        buildingId: other.building.id,
        name: 'Other Building Shop',
        externalId: 'SHOP-1',
      },
    });

    return { building, node, poiNode, poi, other };
  }

  test('a plain node id resolves with no POI info', async () => {
    const { building, node } = await seed();
    const result = await resolveDestination(building.id, node.id);
    expect(result).toEqual({ ok: true, nodeId: node.id, poi: null });
  });

  test('an invalid raw node id is rejected', async () => {
    const { building } = await seed();
    const result = await resolveDestination(building.id, 'not-an-id');
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  test('poi:<id> resolves to the POI\'s node', async () => {
    const { building, poi, poiNode } = await seed();
    const result = await resolveDestination(building.id, `poi:${poi.id}`);
    expect(result).toMatchObject({
      ok: true,
      nodeId: poiNode.id,
      poi: { id: poi.id, name: 'Test Shop', category: 'Retail' },
    });
  });

  test('poi:<id> for an unknown poi is not found', async () => {
    const { building } = await seed();
    const result = await resolveDestination(building.id, 'poi:cabogus000000000000000');
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  test('poi:<malformed id> is rejected as invalid', async () => {
    const { building } = await seed();
    const result = await resolveDestination(building.id, 'poi:not-an-id');
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  test('ext:<code> resolves against Poi.externalId scoped to the building', async () => {
    const { building, poi, poiNode } = await seed();
    const result = await resolveDestination(building.id, 'ext:SHOP-1');
    expect(result).toMatchObject({
      ok: true,
      nodeId: poiNode.id,
      poi: { id: poi.id, name: 'Test Shop' },
    });
  });

  test('ext:<code> falls back to Node.externalId when no Poi matches', async () => {
    const { building, node } = await seed();
    await prisma.node.update({ where: { id: node.id }, data: { externalId: 'NODE-ONLY' } });
    const result = await resolveDestination(building.id, 'ext:NODE-ONLY');
    expect(result).toMatchObject({ ok: true, nodeId: node.id, poi: null });
  });

  test('ext:<code> that only exists in another building is not found', async () => {
    const { building, other } = await seed();
    // A code registered ONLY in `other.building` — proves real per-building
    // scoping, not just "this code doesn't exist anywhere".
    const otherFloor = await createFloor(other.building.id, { floorNumber: 2 });
    await createNode(other.building.id, otherFloor.id, {
      x: 0,
      y: 0,
      type: 'POI',
      externalId: 'ONLY-OTHER-BUILDING',
    });

    const result = await resolveDestination(building.id, 'ext:ONLY-OTHER-BUILDING');
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  test('an empty ext code is rejected as invalid', async () => {
    const { building } = await seed();
    const result = await resolveDestination(building.id, 'ext:');
    expect(result).toMatchObject({ ok: false, status: 400 });
  });
});
