/**
 * Maintenance scripts for the emergency routing data.
 *
 * These are utilities, not an automatic migration runner — nothing imports this
 * file at boot. Run a function from a one-off script when you need it.
 *
 * The previous version of this file seeded buildings with `name` and `address`
 * fields that do not exist on the schema, and created QRCode documents for a
 * model that has since been removed (QR ids are derived from the node id, not
 * stored). Both are gone.
 */

import Building from '../models/building.model.js';
import Floor from '../models/floor.model.js';
import Node from '../models/node.model.js';

/**
 * Ensure the indexes the routing queries rely on exist.
 */
export const createIndexes = async () => {
  await Node.collection.createIndex({ buildingId: 1, floorNumber: 1 });
  await Node.collection.createIndex({ buildingId: 1, floorNumber: 1, type: 1 });
  await Floor.collection.createIndex({ buildingId: 1, floorNumber: 1 }, { unique: true });
};

/**
 * Report structural problems in the routing graph.
 *
 * Worth running against a real building before relying on it in an emergency:
 * a floor with no exit, or a node that cannot reach one, means someone scanning
 * a QR there gets no route.
 *
 * @returns {Promise<{isValid: boolean, issues: string[]}>}
 */
export const validateDatabase = async () => {
  const issues = [];

  const [nodes, buildings] = await Promise.all([
    Node.find().lean(),
    Building.find().select('_id buildingName').lean(),
  ]);

  const buildingIds = new Set(buildings.map((b) => String(b._id)));
  const nodeIds = new Set(nodes.map((n) => String(n._id)));

  for (const node of nodes) {
    if (!buildingIds.has(String(node.buildingId))) {
      issues.push(`Node ${node._id} references a building that no longer exists`);
    }

    for (const connectionId of node.connections || []) {
      if (!nodeIds.has(String(connectionId))) {
        issues.push(`Node ${node._id} has a broken connection to ${connectionId}`);
      }
    }
  }

  // Every floor that has nodes should have at least one exit reachable somewhere
  // in its building.
  const exitsByBuilding = new Map();
  for (const node of nodes) {
    if (node.type === 'exit') {
      exitsByBuilding.set(String(node.buildingId), true);
    }
  }
  for (const buildingId of new Set(nodes.map((n) => String(n.buildingId)))) {
    if (!exitsByBuilding.has(buildingId)) {
      issues.push(`Building ${buildingId} has nodes but no exit node — scans there cannot produce a route`);
    }
  }

  return { isValid: issues.length === 0, issues };
};

/**
 * Strip connection ids that point at nodes which no longer exist.
 * @returns {Promise<number>} number of nodes repaired
 */
export const repairConnections = async () => {
  const nodes = await Node.find().lean();
  const nodeIds = new Set(nodes.map((n) => String(n._id)));
  let repaired = 0;

  for (const node of nodes) {
    const valid = (node.connections || []).filter((id) => nodeIds.has(String(id)));
    if (valid.length !== (node.connections || []).length) {
      await Node.updateOne({ _id: node._id }, { connections: valid });
      repaired++;
    }
  }

  return repaired;
};
