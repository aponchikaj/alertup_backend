import Node from '../models/node.model.js';

/**
 * Find shortest path from start node to nearest exit using BFS with multi-floor support
 * @param {String} startNodeId - MongoDB ObjectId of starting node
 * @returns {Promise<Array>} Array of node objects representing the shortest route
 * @throws {Error} If start node not found or no route to exit exists
 */
export const findShortestRoute = async (startNodeId) => {
  if (!startNodeId) {
    throw new Error('Start node ID is required');
  }

  try {
    const startNode = await Node.findById(startNodeId).populate('connections');

    if (!startNode) {
      throw new Error('Start node not found');
    }

    // Check if starting node is already an exit
    if (startNode.type === 'exit') {
      return [
        {
          x: startNode.x,
          y: startNode.y,
          type: startNode.type,
          label: startNode.label,
          floor: startNode.floorNumber,
        },
      ];
    }

    // Enhanced BFS to find shortest path to exit with multi-floor support
    const queue = [
      {
        nodeId: startNode._id,
        path: [startNode],
      },
    ];

    const visited = new Set([startNode._id.toString()]);
    let nodesExplored = 0;
    const MAX_EXPLORATION = 10000; // Prevent infinite loops on large graphs

    while (queue.length > 0 && nodesExplored < MAX_EXPLORATION) {
      nodesExplored++;
      const { nodeId, path } = queue.shift();

      if (!path || path.length === 0) {
        continue;
      }

      const currentNode = path[path.length - 1];

      // Validate current node
      if (!currentNode || typeof currentNode.type !== 'string') {
        continue;
      }

      // Check if we reached an exit
      if (currentNode.type === 'exit') {
        return path.map((node) => ({
          x: node.x,
          y: node.y,
          type: node.type,
          label: node.label || undefined,
          floor: node.floorNumber,
        }));
      }

      // Add connected nodes to queue with special handling for stairs
      const connections = Array.isArray(currentNode.connections)
        ? currentNode.connections
        : [];

      for (const connectionId of connections) {
        const connIdStr = connectionId.toString();
        if (!visited.has(connIdStr)) {
          visited.add(connIdStr);

          // Use lean() for better performance on subsequent queries
          const nextNode = await Node.findById(connectionId).populate('connections');
          if (nextNode && nextNode.type) {
            // Prioritize stairs when changing floors for emergency routing
            if (nextNode.type === 'stairs' && nextNode.floorNumber !== currentNode.floorNumber) {
              // Move stairs connections to front of queue for multi-floor routing
              queue.unshift({
                nodeId: nextNode._id,
                path: [...path, nextNode],
              });
            } else {
              queue.push({
                nodeId: nextNode._id,
                path: [...path, nextNode],
              });
            }
          }
        }
      }
    }

    // No exit found
    const message =
      nodesExplored >= MAX_EXPLORATION
        ? 'Search limit exceeded - possible infinite loop in graph'
        : 'No exit route found from this location';
    throw new Error(message);
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error('Unknown error in BFS routing');
  }
};

/**
 * Calculate distance between two points
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @returns {number} Euclidean distance
 */
export const calculateDistance = (x1, y1, x2, y2) => {
  return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
};

/**
 * Find all emergency exits in a building
 * @param {String} buildingId - MongoDB ObjectId of building
 * @returns {Promise<Array>} Array of exit nodes
 */
export const findAllExits = async (buildingId) => {
  try {
    const exits = await Node.find({
      buildingId,
      type: 'exit',
    }).lean();
    
    return exits.map(exit => ({
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
 * Validate route continuity and check for floor transitions
 * @param {Array} route - Array of route points
 * @returns {Object} Validation result with floor changes
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
