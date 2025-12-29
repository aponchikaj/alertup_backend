import Node from '../models/node.model.js';
import Floor from '../models/floor.model.js';

/**
 * Advanced routing utilities for emergency exit system
 */

/**
 * Find all possible routes to exits (not just shortest)
 * @param {String} startNodeId - Starting node
 * @param {Object} options - { maxDepth, includeStairs }
 * @returns {Promise<Array>} Array of all possible routes
 */
export const findAllRoutesToExit = async (startNodeId, options = {}) => {
  const { maxDepth = 50, includeStairs = true } = options;
  const routes = [];

  const dfs = async (nodeId, currentPath, visited) => {
    if (currentPath.length > maxDepth) return;

    const node = await Node.findById(nodeId).populate('connections');
    if (!node) return;

    currentPath.push(node);

    if (node.type === 'exit') {
      routes.push([...currentPath.map(n => ({
        x: n.x,
        y: n.y,
        type: n.type,
        label: n.label
      }))]);
      currentPath.pop();
      return;
    }

    for (const connectionId of node.connections || []) {
      if (!visited.has(connectionId.toString())) {
        visited.add(connectionId.toString());
        await dfs(connectionId, currentPath, visited);
        visited.delete(connectionId.toString());
      }
    }

    currentPath.pop();
  };

  const visited = new Set([startNodeId.toString()]);
  await dfs(startNodeId, [], visited);

  // Sort by length (shortest first)
  routes.sort((a, b) => a.length - b.length);
  return routes;
};

/**
 * Validate graph connectivity for a building floor
 * @param {String} buildingId - Building identifier
 * @param {Number} floorNumber - Floor to validate
 * @returns {Promise<Object>} Validation report
 */
export const validateFloorGraph = async (buildingId, floorNumber) => {
  const nodes = await Node.find({
    buildingId,
    floorNumber
  }).populate('connections');

  const report = {
    totalNodes: nodes.length,
    totalExits: 0,
    disconnectedNodes: [],
    unreachableExits: [],
    warnings: []
  };

  // Find exits
  const exits = nodes.filter(n => n.type === 'exit');
  report.totalExits = exits.length;

  if (report.totalExits === 0) {
    report.warnings.push('No exits defined for this floor');
  }

  // Find disconnected nodes using BFS from first node
  if (nodes.length > 0) {
    const startNode = nodes[0];
    const reachable = new Set();
    const queue = [startNode._id];
    reachable.add(startNode._id.toString());

    while (queue.length > 0) {
      const currentId = queue.shift();
      const current = nodes.find(n => n._id.toString() === currentId.toString());

      if (current && current.connections) {
        for (const connId of current.connections) {
          if (!reachable.has(connId.toString())) {
            reachable.add(connId.toString());
            queue.push(connId);
          }
        }
      }
    }

    // Find unreachable nodes
    nodes.forEach(node => {
      if (!reachable.has(node._id.toString())) {
        report.disconnectedNodes.push({
          id: node._id,
          label: node.label || 'Unknown',
          type: node.type
        });
      }
    });
  }

  // Check if exits are reachable from all regions
  for (const exit of exits) {
    const canReach = new Set([exit._id.toString()]);
    const queue = [exit._id];

    while (queue.length > 0) {
      const currentId = queue.shift();
      const current = nodes.find(n => n._id.toString() === currentId.toString());

      if (current && current.connections) {
        for (const connId of current.connections) {
          if (!canReach.has(connId.toString())) {
            canReach.add(connId.toString());
            queue.push(connId);
          }
        }
      }
    }

    const unreachable = nodes.filter(
      n => !canReach.has(n._id.toString())
    );

    if (unreachable.length > 0) {
      report.unreachableExits.push({
        exit: exit.label || 'Unknown',
        unreachableNodes: unreachable.length
      });
    }
  }

  if (report.disconnectedNodes.length > 0) {
    report.warnings.push(
      `${report.disconnectedNodes.length} disconnected nodes found`
    );
  }

  return report;
};

/**
 * Calculate route distance in SVG units
 * @param {Array} route - Route array of nodes
 * @returns {Number} Total distance
 */
export const calculateRouteDistance = (route) => {
  if (route.length < 2) return 0;

  let totalDistance = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const current = route[i];
    const next = route[i + 1];
    const distance = Math.sqrt(
      Math.pow(next.x - current.x, 2) + Math.pow(next.y - current.y, 2)
    );
    totalDistance += distance;
  }

  return totalDistance;
};

/**
 * Get nearby exits from a specific location
 * @param {String} nodeId - Starting node
 * @param {Number} maxDistance - Maximum distance to search
 * @returns {Promise<Array>} Array of nearby exits sorted by distance
 */
export const getNearbyExits = async (nodeId, maxDistance = 1000) => {
  const startNode = await Node.findById(nodeId);
  if (!startNode) throw new Error('Node not found');

  const exits = await Node.find({
    buildingId: startNode.buildingId,
    floorNumber: startNode.floorNumber,
    type: 'exit'
  });

  const nearby = [];

  for (const exit of exits) {
    const distance = Math.sqrt(
      Math.pow(exit.x - startNode.x, 2) +
      Math.pow(exit.y - startNode.y, 2)
    );

    if (distance <= maxDistance) {
      nearby.push({
        exitId: exit._id,
        label: exit.label,
        distance: Math.round(distance),
        x: exit.x,
        y: exit.y
      });
    }
  }

  // Sort by distance
  nearby.sort((a, b) => a.distance - b.distance);
  return nearby;
};

/**
 * Find nodes of specific type on a floor
 * @param {String} buildingId - Building identifier
 * @param {Number} floorNumber - Floor number
 * @param {String} type - Node type (path | exit | stairs)
 * @returns {Promise<Array>} Array of nodes of specified type
 */
export const getNodesByType = async (buildingId, floorNumber, type) => {
  const nodes = await Node.find({
    buildingId,
    floorNumber,
    type
  });

  return nodes.map(n => ({
    id: n._id,
    x: n.x,
    y: n.y,
    label: n.label,
    type: n.type
  }));
};

/**
 * Create nodes in bulk (for floor initialization)
 * @param {String} buildingId - Building identifier
 * @param {Array} nodeData - Array of node definitions
 * @returns {Promise<Array>} Created nodes
 */
export const createNodesBulk = async (buildingId, nodeData) => {
  const createdNodes = [];

  for (const data of nodeData) {
    const node = await Node.create({
      buildingId,
      ...data
    });
    createdNodes.push(node);
  }

  return createdNodes;
};

/**
 * Update node connections
 * @param {String} nodeId - Node to update
 * @param {Array} connectionIds - Array of node IDs to connect
 * @returns {Promise<Object>} Updated node
 */
export const updateNodeConnections = async (nodeId, connectionIds) => {
  const node = await Node.findByIdAndUpdate(
    nodeId,
    { connections: connectionIds },
    { new: true }
  ).populate('connections');

  return node;
};

/**
 * Get floor statistics
 * @param {String} buildingId - Building identifier
 * @param {Number} floorNumber - Floor number
 * @returns {Promise<Object>} Floor statistics
 */
export const getFloorStatistics = async (buildingId, floorNumber) => {
  const nodes = await Node.find({
    buildingId,
    floorNumber
  });

  const stats = {
    totalNodes: nodes.length,
    pathNodes: 0,
    exitNodes: 0,
    stairNodes: 0,
    averageConnections: 0,
    totalConnections: 0
  };

  nodes.forEach(node => {
    switch (node.type) {
      case 'path':
        stats.pathNodes++;
        break;
      case 'exit':
        stats.exitNodes++;
        break;
      case 'stairs':
        stats.stairNodes++;
        break;
    }
    stats.totalConnections += node.connections?.length || 0;
  });

  stats.averageConnections =
    stats.totalNodes > 0 ? stats.totalConnections / stats.totalNodes : 0;

  return stats;
};
