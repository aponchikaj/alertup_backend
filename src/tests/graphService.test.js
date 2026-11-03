import prisma from '../db/prisma.js';
import {
  loadBuildingGraph,
  ASSUMED_PIXELS_PER_METER,
} from '../features/wayfinding/graphService.js';
import {
  createOwnerWithBuilding,
  createFloor,
  createNode,
  connectNodes,
} from './helpers.js';

/**
 * Loader contract for Slice 1: every adjacency entry carries the edge identity
 * and routing metadata the assembler needs, one-way edges are expanded in one
 * direction only, and a floor with no scale still yields metres (flagged).
 */

describe('loadBuildingGraph', () => {
  test('adjacency entries carry the edge id and are mirrored into radj', async () => {
    const { building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, { scalePixelsPerMeter: 10 });
    const a = await createNode(building.id, floor.id, { x: 0, y: 0 });
    const b = await createNode(building.id, floor.id, { x: 100, y: 0 });
    const edge = await connectNodes(a, b, {
      tags: ['indoor'],
      rank: 'SECONDARY',
      visibility: 'STAFF',
    });

    const graph = await loadBuildingGraph(building.id);

    expect(graph.buildingId).toBe(building.id);
    expect(typeof graph.loadedAt).toBe('number');
    expect(graph.edgesById.get(edge.id)).toMatchObject({
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      transitType: 'WALKWAY',
    });

    const forward = graph.adj.get(edge.sourceNodeId);
    expect(forward).toHaveLength(1);
    expect(forward[0]).toMatchObject({
      edgeId: edge.id,
      to: edge.targetNodeId,
      cost: 100,
      distance: 100,
      lengthM: 10,
      lengthMAssumed: false,
      transitType: 'WALKWAY',
      accessible: true,
      direction: 'BOTH',
      tags: ['indoor'],
      rank: 'SECONDARY',
      visibility: 'STAFF',
      forward: true,
    });

    // BOTH: the other way round is there too, flagged as the reverse traversal.
    expect(graph.adj.get(edge.targetNodeId)).toHaveLength(1);
    expect(graph.adj.get(edge.targetNodeId)[0]).toMatchObject({
      edgeId: edge.id,
      to: edge.sourceNodeId,
      forward: false,
    });

    // Every adj[a] -> b push is mirrored into radj[b] pointing back at a.
    expect(graph.radj.get(edge.targetNodeId)).toHaveLength(1);
    expect(graph.radj.get(edge.targetNodeId)[0]).toMatchObject({
      edgeId: edge.id,
      to: edge.sourceNodeId,
      forward: true,
    });
    expect(graph.radj.get(edge.sourceNodeId)[0]).toMatchObject({
      edgeId: edge.id,
      to: edge.targetNodeId,
      forward: false,
    });

    // Nodes and floors keep the legacy fields and gain the new ones.
    expect(graph.nodes.get(a.id)).toMatchObject({
      id: a.id,
      floorId: floor.id,
      floorNumber: 1,
      level: 1,
      visibility: 'PUBLIC',
      externalId: null,
    });
    expect(graph.floors.get(floor.id)).toMatchObject({
      id: floor.id,
      floorNumber: 1,
      verticalOrder: null,
      shortName: null,
      scalePixelsPerMeter: 10,
    });
  });

  test('a REVERSE edge only appears in adj[target]', async () => {
    const { building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, { scalePixelsPerMeter: 10 });
    const a = await createNode(building.id, floor.id, { x: 0, y: 0 });
    const b = await createNode(building.id, floor.id, { x: 100, y: 0 });
    const reverse = await connectNodes(a, b, { direction: 'REVERSE' });
    const c = await createNode(building.id, floor.id, { x: 0, y: 200 });
    const d = await createNode(building.id, floor.id, { x: 100, y: 200 });
    const forward = await connectNodes(c, d, { direction: 'FORWARD' });

    const graph = await loadBuildingGraph(building.id);

    expect(graph.adj.get(reverse.sourceNodeId)).toEqual([]);
    expect(graph.adj.get(reverse.targetNodeId).map((e) => e.to)).toEqual([
      reverse.sourceNodeId,
    ]);
    expect(graph.adj.get(reverse.targetNodeId)[0].forward).toBe(false);
    expect(graph.radj.get(reverse.sourceNodeId).map((e) => e.to)).toEqual([
      reverse.targetNodeId,
    ]);

    expect(graph.adj.get(forward.targetNodeId)).toEqual([]);
    expect(graph.adj.get(forward.sourceNodeId).map((e) => e.to)).toEqual([
      forward.targetNodeId,
    ]);
    expect(graph.adj.get(forward.sourceNodeId)[0].forward).toBe(true);
  });

  test('an unscaled floor falls back to 50 px per metre and is flagged', async () => {
    const { building } = await createOwnerWithBuilding();
    const scaled = await createFloor(building.id, {
      floorNumber: 1,
      scalePixelsPerMeter: 20,
    });
    const unscaled = await createFloor(building.id, { floorNumber: 2 });

    const a = await createNode(building.id, unscaled.id, { x: 0, y: 0 });
    const b = await createNode(building.id, unscaled.id, { x: 200, y: 0 });
    const edge = await connectNodes(a, b);

    const graph = await loadBuildingGraph(building.id);

    expect(ASSUMED_PIXELS_PER_METER).toBe(50);
    expect(graph.unscaledFloorIds.has(unscaled.id)).toBe(true);
    expect(graph.unscaledFloorIds.has(scaled.id)).toBe(false);

    const entry = graph.adj.get(edge.sourceNodeId)[0];
    expect(entry.lengthM).toBeCloseTo(4, 6); // 200 px / 50
    expect(entry.lengthMAssumed).toBe(true);
  });

  test('a manual same-floor weight becomes the metre length', async () => {
    const { building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, { scalePixelsPerMeter: 10 });
    const a = await createNode(building.id, floor.id, { x: 0, y: 0 });
    const b = await createNode(building.id, floor.id, { x: 100, y: 0 });
    // The editor let an owner overrule the on-canvas distance: the corridor is
    // really 300 px long even though the nodes sit 100 px apart.
    const manual = await connectNodes(a, b, { weight: 300 });

    const graph = await loadBuildingGraph(building.id);
    const entry = graph.adj.get(manual.sourceNodeId)[0];
    expect(entry.distance).toBe(100);
    expect(entry.cost).toBe(300);
    expect(entry.lengthM).toBeCloseTo(30, 6); // 300 / 10
    expect(entry.lengthMAssumed).toBe(false);

    // An explicit lengthM beats everything else.
    await prisma.edge.update({ where: { id: manual.id }, data: { lengthM: 42 } });
    const withExplicit = await loadBuildingGraph(building.id);
    expect(withExplicit.adj.get(manual.sourceNodeId)[0].lengthM).toBe(42);
  });

  test('cross-floor edges have no metre length and levels come from verticalOrder', async () => {
    const { building } = await createOwnerWithBuilding();
    await prisma.building.update({
      where: { id: building.id },
      data: { routingProfile: { walkSpeedMps: 0.9 } },
    });
    const ground = await createFloor(building.id, {
      floorNumber: 0,
      verticalOrder: 1,
      shortName: 'G',
    });
    const first = await createFloor(building.id, {
      floorNumber: 5,
      verticalOrder: 2,
      shortName: '1',
    });
    const a = await createNode(building.id, ground.id, { x: 0, y: 0, type: 'TRANSIT' });
    const b = await createNode(building.id, first.id, { x: 0, y: 0, type: 'TRANSIT' });
    const stairs = await connectNodes(a, b, {
      transitType: 'STAIRS',
      accessible: false,
      distance: 0,
      weight: 400,
    });

    const graph = await loadBuildingGraph(building.id);

    expect(graph.routingProfile).toEqual({ walkSpeedMps: 0.9 });
    expect(graph.nodes.get(a.id).level).toBe(1);
    expect(graph.nodes.get(b.id).level).toBe(2);
    expect(graph.floors.get(ground.id).shortName).toBe('G');

    const entry = graph.adj.get(stairs.sourceNodeId)[0];
    expect(entry.lengthM).toBeNull();
    expect(entry.lengthMAssumed).toBe(false);
    expect(entry.cost).toBe(400);
    expect(entry.accessible).toBe(false);
  });
});
