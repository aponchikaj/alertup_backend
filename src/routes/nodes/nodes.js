import express from 'express';
import Node from '../../models/node.model.js';
import BUILDINGS from '../../models/building.model.js';
import { isValidObjectId } from 'mongoose';
import ownerOnlyAuth from '../../middlewares/ownerOnlyAuth.js';
import whoami from '../../middlewares/whoami.js';

const router = express.Router();

/**
 * Validate node data
 */
const validateNodeData = (data) => {
  const errors = [];
  
  if (!data.buildingId || !isValidObjectId(data.buildingId)) {
    errors.push('Valid building ID is required');
  }
  
  if (typeof data.floorNumber !== 'number' || data.floorNumber < 0) {
    errors.push('Valid floor number is required');
  }
  
  if (typeof data.x !== 'number' || typeof data.y !== 'number') {
    errors.push('Valid x, y coordinates are required');
  }
  
  if (!data.type || !['path', 'exit', 'stairs'].includes(data.type)) {
    errors.push('Type must be path, exit, or stairs');
  }
  
  return errors;
};

/**
 * Resolve a caller-supplied connections list to ids that actually exist in this
 * building.
 *
 * Connections were previously stored verbatim, so a malformed id raised a
 * CastError (reported as a 200 "Server error") and an id belonging to another
 * building would have been walkable by the routing graph.
 */
const resolveConnections = async (connections, buildingId) => {
  if (!Array.isArray(connections) || connections.length === 0) return [];

  const candidates = connections.filter((id) => isValidObjectId(id));
  if (candidates.length === 0) return [];

  const found = await Node.find({ _id: { $in: candidates }, buildingId }).distinct('_id');
  return found;
};

/**
 * Create a new node
 */
router.post('/api/nodes', whoami, ownerOnlyAuth, async (req, res) => {
  try {
    const { buildingId, floorNumber, x, y, type, label, connections } = req.body;

    // Validate required fields
    const validationErrors = validateNodeData(req.body);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validationErrors
      });
    }

    const validConnections = await resolveConnections(connections, buildingId);

    // Create new node
    const newNode = new Node({
      buildingId,
      floorNumber,
      x,
      y,
      type,
      label,
      connections: validConnections
    });

    await newNode.save();

    // Edges are undirected in the routing graph, so the reverse edge is written
    // too. Storing only one direction left the graph asymmetric and made
    // Dijkstra treat a corridor as passable one way only.
    if (validConnections.length > 0) {
      await Node.updateMany(
        { _id: { $in: validConnections } },
        { $addToSet: { connections: newNode._id } }
      );
    }

    res.json({
      success: true,
      message: 'Node created successfully',
      node: newNode
    });
  } catch (error) {
    console.error('Error creating node:', error);
    // Was res.json without a status, so a failed creation was reported as
    // HTTP 200 with success:false.
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

/**
 * Get all nodes for a building
 */
router.get('/api/nodes/building/:buildingId', whoami, ownerOnlyAuth, async (req, res) => {
  try {
    const { buildingId } = req.params;
    
    if (!isValidObjectId(buildingId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid building ID'
      });
    }
    
    const nodes = await Node.find({ 
      buildingId
    }).sort({ floorNumber: 1, x: 1, y: 1 });
    
    res.status(200).json({
      success: true,
      nodes
    });
  } catch (error) {
    console.error('Error fetching nodes:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

/**
 * Update a node
 */
router.put('/api/nodes/:nodeId', whoami, ownerOnlyAuth, async (req, res) => {
  try {
    const { nodeId } = req.params;
    const { x, y, type, label, connections } = req.body;
    
    if (!isValidObjectId(nodeId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid node ID'
      });
    }
    
    // Find the node first
    const node = await Node.findById(nodeId);
    if (!node) {
      return res.status(404).json({
        success: false,
        message: 'Node not found'
      });
    }
    
    // Authorization is handled by ownerOnlyAuth middleware (building owners only)
    
    // Validate update data
    const updateData = {};
    if (x !== undefined) {
      if (typeof x !== 'number' || x < 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid x coordinate'
        });
      }
      updateData.x = x;
    }
    
    if (y !== undefined) {
      if (typeof y !== 'number' || y < 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid y coordinate'
        });
      }
      updateData.y = y;
    }
    
    if (type !== undefined) {
      if (!['path', 'exit', 'stairs'].includes(type)) {
        return res.status(400).json({
          success: false,
          message: 'Type must be path, exit, or stairs'
        });
      }
      updateData.type = type;
    }
    
    if (label !== undefined) {
      updateData.label = label;
    }
    
    if (connections !== undefined) {
      if (!Array.isArray(connections)) {
        return res.status(400).json({
          success: false,
          message: 'Connections must be an array'
        });
      }
      updateData.connections = await resolveConnections(connections, node.buildingId);
    }

    // Update timestamp
    updateData.updatedAt = new Date();

    const updatedNode = await Node.findByIdAndUpdate(
      nodeId,
      updateData,
      { new: true }
    );

    // Mirror the edge change on the other side. Edits were one-directional, so
    // removing a connection here left the reverse edge in place and the routing
    // graph still treated the deleted corridor as walkable.
    if (updateData.connections) {
      const before = (node.connections || []).map((id) => id.toString());
      const after = updateData.connections.map((id) => id.toString());

      const added = after.filter((id) => !before.includes(id));
      const removed = before.filter((id) => !after.includes(id));

      if (added.length > 0) {
        await Node.updateMany(
          { _id: { $in: added } },
          { $addToSet: { connections: updatedNode._id } }
        );
      }
      if (removed.length > 0) {
        await Node.updateMany(
          { _id: { $in: removed } },
          { $pull: { connections: updatedNode._id } }
        );
      }
    }

    res.status(200).json({
      success: true,
      message: 'Node updated successfully',
      node: updatedNode
    });
  } catch (error) {
    console.error('Error updating node:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating node',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Delete a node
 */
router.delete('/api/nodes/:nodeId', whoami, ownerOnlyAuth, async (req, res) => {
  try {
    const { nodeId } = req.params;
    
    if (!isValidObjectId(nodeId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid node ID'
      });
    }
    
    // Find the node first
    const node = await Node.findById(nodeId);
    if (!node) {
      return res.status(404).json({
        success: false,
        message: 'Node not found'
      });
    }
    
    // Authorization is handled by ownerOnlyAuth middleware (building owners only)
    
    // Remove connections from other nodes, so no edge points at a missing node.
    await Node.updateMany(
      { connections: nodeId },
      { $pull: { connections: nodeId } }
    );

    await Node.findByIdAndDelete(nodeId);

    // QR codes need no cleanup: the code is derived from the node id rather
    // than stored, so deleting the node invalidates it automatically.
    res.status(200).json({
      success: true,
      message: 'Node deleted successfully',
      data: {
        deletedNodeId: nodeId,
        buildingId: node.buildingId
      }
    });
  } catch (error) {
    console.error('Error deleting node:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while deleting node',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Connect nodes (create connections between nodes)
 */
router.post('/api/nodes/connect', whoami, ownerOnlyAuth, async (req, res) => {
  try {
    const { buildingId, node1Id, node2Id } = req.body;
    
    if (!buildingId || !node1Id || !node2Id) {
      return res.status(400).json({
        success: false,
        message: 'buildingId, node1Id, and node2Id are required'
      });
    }
    
    if (!isValidObjectId(buildingId) || !isValidObjectId(node1Id) || !isValidObjectId(node2Id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid ID format'
      });
    }
    
    // Prevent self-connection
    if (node1Id === node2Id) {
      return res.status(400).json({
        success: false,
        message: 'Cannot connect a node to itself'
      });
    }
    
    const node1 = await Node.findById(node1Id);
    const node2 = await Node.findById(node2Id);
    
    if (!node1 || !node2) {
      return res.status(404).json({
        success: false,
        message: 'One or both nodes not found'
      });
    }
    
    // Verify nodes belong to the specified building
    if (node1.buildingId.toString() !== buildingId || node2.buildingId.toString() !== buildingId) {
      return res.status(400).json({
        success: false,
        message: 'Nodes must belong to the specified building'
      });
    }
    
    // Authorization is handled by ownerOnlyAuth middleware (building owners only)
    
    // Check if connection already exists
    if (node1.connections.includes(node2Id)) {
      return res.status(400).json({
        success: false,
        message: 'Nodes are already connected'
      });
    }
    
    // Add connection (bidirectional)
    node1.connections.push(node2Id);
    node2.connections.push(node1Id);
    
    await node1.save();
    await node2.save();
    
    res.status(200).json({
      success: true,
      message: 'Nodes connected successfully',
      data: {
        connection: {
          buildingId,
          node1Id,
          node2Id,
          node1: node1,
          node2: node2
        }
      }
    });
  } catch (error) {
    console.error('Error connecting nodes:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while connecting nodes',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

export default router;
