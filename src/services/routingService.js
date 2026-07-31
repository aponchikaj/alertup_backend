import Node from '../models/node.model.js';

/**
 * Cost, in the same units as the SVG coordinate space, charged for moving
 * between floors via a stairs node. Floor transitions have no meaningful
 * Euclidean length, so they get a fixed penalty that makes the router prefer
 * staying on the current floor when an exit is available there — which is also
 * the correct evacuation behaviour.
 */
const FLOOR_CHANGE_COST = 400;

/** Guard against pathological graphs. */
const MAX_NODES = 20000;

export const calculateDistance = (x1, y1, x2, y2) => {
  return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
};

/**
 * Cost of traversing the edge between two nodes.
 * Same floor: straight-line distance. Different floor: fixed penalty.
 */
const edgeCost = (a, b) => {
  if (a.floorNumber !== b.floorNumber) return FLOOR_CHANGE_COST;
  return calculateDistance(a.x, a.y, b.x, b.y);
};

/**
 * Load every node in a building and index it by id.
 *
 * One query for the whole graph. The previous implementation issued a
 * `findById` per edge from inside the search loop, which meant hundreds of
 * round-trips on the single request that happens during a fire.
 */
const loadBuildingGraph = async (buildingId) => {
  const nodes = await Node.find({ buildingId }).limit(MAX_NODES).lean();

  const graph = new Map();
  for (const node of nodes) {
    graph.set(String(node._id), {
      _id: String(node._id),
      x: node.x,
      y: node.y,
      type: node.type,
      label: node.label,
      floorNumber: node.floorNumber,
      connections: (node.connections || []).map(String),
    });
  }
  return graph;
};

/** Shape a graph node for the API response. */
const toRoutePoint = (node) => ({
  _id: node._id,
  x: node.x,
  y: node.y,
  type: node.type,
  label: node.label || undefined,
  floor: node.floorNumber,
});

/**
 * Find the cheapest path from a start node to the nearest exit.
 *
 * Dijkstra rather than a plain BFS: BFS minimises the number of hops, which is
 * not the same as the shortest walk. Two long corridors beat three short ones
 * on hop count while being physically further, and for an evacuation route the
 * physical distance is what matters. Works across floors via stairs nodes.
 *
 * @param {String} startNodeId
 * @returns {Promise<Array>} route points from start to exit, inclusive
 * @throws {Error} if the start node is unknown or no exit is reachable
 */
export const findShortestRoute = async (startNodeId) => {
  if (!startNodeId) {
    throw new Error('Start node ID is required');
  }

  const startNode = await Node.findById(startNodeId).lean();
  if (!startNode) {
    throw new Error('Start node not found');
  }

  const graph = await loadBuildingGraph(startNode.buildingId);
  const startId = String(startNode._id);
  const start = graph.get(startId);

  if (!start) {
    throw new Error('Start node not found');
  }

  // Already at an exit.
  if (start.type === 'exit') {
    return [toRoutePoint(start)];
  }

  const dist = new Map([[startId, 0]]);
  const prev = new Map();
  const settled = new Set();

  // Linear-scan Dijkstra. Buildings have tens to low hundreds of nodes, so an
  // O(V^2) scan is comfortably faster than the allocation cost of a heap.
  while (settled.size < graph.size) {
    let currentId = null;
    let currentDist = Infinity;

    for (const [id, d] of dist) {
      if (!settled.has(id) && d < currentDist) {
        currentDist = d;
        currentId = id;
      }
    }

    // Remaining nodes are unreachable from the start.
    if (currentId === null) break;

    const current = graph.get(currentId);
    settled.add(currentId);

    // First exit settled is the cheapest reachable exit.
    if (current.type === 'exit') {
      const path = [];
      let cursor = currentId;
      while (cursor !== undefined) {
        path.unshift(toRoutePoint(graph.get(cursor)));
        cursor = prev.get(cursor);
      }
      return path;
    }

    for (const neighbourId of current.connections) {
      const neighbour = graph.get(neighbourId);
      // Skip dangling references to deleted nodes.
      if (!neighbour || settled.has(neighbourId)) continue;

      const candidate = currentDist + edgeCost(current, neighbour);
      if (candidate < (dist.get(neighbourId) ?? Infinity)) {
        dist.set(neighbourId, candidate);
        prev.set(neighbourId, currentId);
      }
    }
  }

  throw new Error('No exit route found from this location');
};

/**
 * Find all emergency exits in a building
 */
export const findAllExits = async (buildingId) => {
  try {
    const exits = await Node.find({ buildingId, type: 'exit' }).lean();

    return exits.map((exit) => ({
      _id: exit._id,
      x: exit.x,
      y: exit.y,
      floor: exit.floorNumber,
      label: exit.label,
    }));
  } catch (error) {
    throw new Error(`Failed to find exits: ${error.message}`);
  }
};

/**
 * Describe where a route changes floors, so the UI can tell the person
 * "take the stairs to floor 2" instead of silently drawing a broken line.
 *
 * @param {Array} route - route points from findShortestRoute
 */
export const validateRoute = (route) => {
  if (!Array.isArray(route) || route.length === 0) {
    return { valid: false, error: 'Route is empty or invalid' };
  }

  const floorChanges = [];
  let currentFloor = route[0].floor;

  for (let i = 1; i < route.length; i++) {
    if (route[i].floor !== currentFloor) {
      floorChanges.push({
        from: currentFloor,
        to: route[i].floor,
        atStep: i,
        nodeType: route[i].type,
      });
      currentFloor = route[i].floor;
    }
  }

  return {
    valid: true,
    floorChanges,
    hasStairs: floorChanges.length > 0,
  };
};

/**
 * Total walking distance of a route, ignoring floor transitions.
 */
export const routeDistance = (route) => {
  if (!Array.isArray(route) || route.length < 2) return 0;

  let total = 0;
  for (let i = 1; i < route.length; i++) {
    if (route[i].floor !== route[i - 1].floor) continue;
    total += calculateDistance(route[i - 1].x, route[i - 1].y, route[i].x, route[i].y);
  }
  return Math.round(total);
};
