import prisma from '../db/prisma.js';
import { createOwnerWithBuilding, createFloor, createNode, connectNodes } from './helpers.js';

/**
 * Slice 1 "Foundations + Routing Quality": additive schema smoke tests.
 * These pin the defaults/uniqueness/round-trip behaviour the new columns and
 * models must have — not full feature behaviour (that's covered elsewhere).
 */

describe('slice1 schema additions', () => {
  test('edge defaults are BOTH/PRIMARY/PUBLIC with empty tags', async () => {
    const { building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id);
    const a = await createNode(building.id, floor.id, { x: 0, y: 0 });
    const b = await createNode(building.id, floor.id, { x: 10, y: 0 });

    const edge = await connectNodes(a, b);

    expect(edge.direction).toBe('BOTH');
    expect(edge.rank).toBe('PRIMARY');
    expect(edge.visibility).toBe('PUBLIC');
    expect(edge.tags).toEqual([]);
    expect(edge.lengthM).toBeNull();
  });

  test('poi externalId is unique per building but reusable across buildings', async () => {
    const { building: buildingA } = await createOwnerWithBuilding();
    const { building: buildingB } = await createOwnerWithBuilding();

    const floorA = await createFloor(buildingA.id);
    const nodeA1 = await createNode(buildingA.id, floorA.id, { type: 'POI' });
    const nodeA2 = await createNode(buildingA.id, floorA.id, { type: 'POI' });

    const floorB = await createFloor(buildingB.id);
    const nodeB1 = await createNode(buildingB.id, floorB.id, { type: 'POI' });

    await prisma.poi.create({
      data: {
        nodeId: nodeA1.id,
        buildingId: buildingA.id,
        externalId: 'shop-1',
        name: 'Shop One',
      },
    });

    // Same externalId in a different building is fine.
    const poiB = await prisma.poi.create({
      data: {
        nodeId: nodeB1.id,
        buildingId: buildingB.id,
        externalId: 'shop-1',
        name: 'Shop One (B)',
      },
    });
    expect(poiB.externalId).toBe('shop-1');

    // Same externalId in the same building must be rejected.
    await expect(
      prisma.poi.create({
        data: {
          nodeId: nodeA2.id,
          buildingId: buildingA.id,
          externalId: 'shop-1',
          name: 'Shop One Duplicate',
        },
      })
    ).rejects.toThrow();
  });

  test('closure and realtime event round-trip', async () => {
    const { building } = await createOwnerWithBuilding();

    const closure = await prisma.closure.create({
      data: {
        buildingId: building.id,
        reason: 'Maintenance',
      },
    });
    expect(closure.costMultiplier).toBeNull();
    expect(closure.edgeIds).toEqual([]);
    expect(closure.nodeIds).toEqual([]);
    expect(closure.endsAt).toBeNull();

    const realtimeEvent = await prisma.realtimeEvent.create({
      data: {
        buildingId: building.id,
        seq: 1n,
        event: 'closure_changed',
        data: { closureId: closure.id },
      },
    });
    expect(typeof realtimeEvent.seq).toBe('bigint');
    expect(realtimeEvent.seq).toBe(1n);
  });
});
