import prisma from '../db/prisma.js';
import { recomputeEdgesForNode } from '../features/mapEditor/edgeService.js';
import { createOwnerWithBuilding, createFloor, createNode, connectNodes } from './helpers.js';

// FX-091: moving a node recomputed its edges with one node lookup per edge
// (N+1) on the global client, outside the move's transaction. It now takes
// the caller's client (the transaction) and reads every edge with both of
// its endpoints in a single query.

/** Wraps a Prisma client, counting `model.method` calls made through it. */
function counting(client) {
  const counts = {};
  const wrapModel = (name) =>
    new Proxy(client[name], {
      get(target, method) {
        const value = target[method];
        if (typeof value !== 'function') return value;
        return (...args) => {
          counts[`${name}.${String(method)}`] = (counts[`${name}.${String(method)}`] || 0) + 1;
          return value.apply(target, args);
        };
      },
    });
  return { db: { node: wrapModel('node'), edge: wrapModel('edge') }, counts };
}

test('recompute reads all edges in one query and writes through the given client', async () => {
  const { building } = await createOwnerWithBuilding();
  const floor = await createFloor(building.id);
  const hub = await createNode(building.id, floor.id, { x: 0, y: 0 });
  const spokes = [];
  for (let i = 1; i <= 5; i++) {
    const n = await createNode(building.id, floor.id, { x: i * 10, y: 0 });
    await connectNodes(hub, n);
    spokes.push(n);
  }
  await prisma.node.update({ where: { id: hub.id }, data: { x: 0, y: 30 } });

  const { db, counts } = counting(prisma);
  await recomputeEdgesForNode(hub.id, db);

  expect(counts['edge.findMany']).toBe(1);
  expect(counts['node.findUnique'] || 0).toBeLessThanOrEqual(1);
  expect(counts['edge.update']).toBe(5);

  const edges = await prisma.edge.findMany({ where: { OR: [{ sourceNodeId: hub.id }, { targetNodeId: hub.id }] } });
  const byOther = Object.fromEntries(
    edges.map((e) => [e.sourceNodeId === hub.id ? e.targetNodeId : e.sourceNodeId, e.distance]),
  );
  for (const [i, n] of spokes.entries()) {
    expect(byOther[n.id]).toBeCloseTo(Math.hypot((i + 1) * 10, 30), 6);
  }
});
