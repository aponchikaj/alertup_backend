import prisma from '../../db/prisma.js';
import { createOwnerWithBuilding, createFloor, createNode } from '../../tests/helpers.js';
import { createEdge, normalizePair } from './edgeService.js';

/**
 * `direction` is relative to the edge's STORED `sourceNodeId`/`targetNodeId`,
 * never to the order the caller happened to pass them in. Edges are stored
 * normalized (source < target), so roughly half of all calls have their ends
 * swapped on the way in — and the two tests below pin both halves, because a
 * single call only ever exercises one of them.
 */
describe('createEdge direction semantics', () => {
  let building;
  let floor;

  beforeEach(async () => {
    ({ building } = await createOwnerWithBuilding());
    floor = await createFloor(building.id, { floorNumber: 1 });
  });

  /** Two nodes, told apart by how their generated ids sort. */
  const nodePair = async () => {
    const one = await createNode(building.id, floor.id, { x: 0, y: 0 });
    const two = await createNode(building.id, floor.id, { x: 100, y: 0 });
    const [lowId] = normalizePair(one.id, two.id);
    return one.id === lowId ? { low: one, high: two } : { low: two, high: one };
  };

  test('pair passed in storage order keeps the direction verbatim', async () => {
    const { low, high } = await nodePair();

    const edge = await createEdge({
      sourceNodeId: low.id,
      targetNodeId: high.id,
      direction: 'FORWARD',
    });

    expect(edge.sourceNodeId).toBe(low.id); // no swap happened
    expect(edge.direction).toBe('FORWARD');
  });

  test('pair passed reversed still stores the direction verbatim', async () => {
    const { low, high } = await nodePair();

    const edge = await createEdge({
      sourceNodeId: high.id,
      targetNodeId: low.id,
      direction: 'FORWARD',
    });

    // The ends were swapped for storage...
    expect(edge.sourceNodeId).toBe(low.id);
    // ...and the direction still reads against the stored ends, so what came
    // back is exactly what a later PATCH of 'FORWARD' would reproduce.
    expect(edge.direction).toBe('FORWARD');

    const reread = await prisma.edge.findUnique({ where: { id: edge.id } });
    expect(reread.direction).toBe('FORWARD');
  });
});
