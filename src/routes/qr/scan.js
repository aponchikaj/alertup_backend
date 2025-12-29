import express from 'express';
import Node from '../../models/node.model.js';
import BUILDINGS from '../../models/building.model.js';
import USERS from '../../models/user.model.js';
import { isValidObjectId } from 'mongoose';

const router = express.Router();

/**
 * GET /route/:qrId
 * Handle QR code scan requests from frontend
 */
router.get('/route/:qrId', async (req, res) => {
  try {
    const { qrId } = req.params;
    
    // Parse QR ID format: qr_${buildingId}_${floorNumber}_${nodeId}
    const qrPattern = /^qr_(.+)_(\d+)_(.+)$/;
    const match = qrId.match(qrPattern);
    
    if (!match) {
      return res.status(400).json({
        success: false,
        message: 'Invalid QR code format',
        qrId
      });
    }
    
    const [, buildingId, floorNumber, nodeId] = match;
    
    // Validate IDs
    if (!isValidObjectId(buildingId) || !isValidObjectId(nodeId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid building or node ID format',
        qrId
      });
    }
    
    const floor = parseInt(floorNumber, 10);
    
    // Find the node
    const node = await Node.findOne({
      _id: nodeId,
      buildingId: buildingId,
      floorNumber: floor
    });
    
    if (!node) {
      return res.status(404).json({
        success: false,
        message: 'Node not found',
        qrId
      });
    }
    
    // Find the building
    const building = await BUILDINGS.findById(buildingId);
    if (!building) {
      return res.status(404).json({
        success: false,
        message: 'Building not found',
        qrId
      });
    }
    
    // Get all nodes for this floor with full connection data
    const floorNodes = await Node.find({
      buildingId: buildingId,
      floorNumber: floor
    }).sort({ x: 1, y: 1 });
    
    // Build complete graph for pathfinding
    const nodeGraph = {};
    floorNodes.forEach(node => {
      nodeGraph[node._id.toString()] = {
        id: node._id.toString(),
        x: node.x,
        y: node.y,
        type: node.type,
        label: node.label || `${node.type} (${node.x}, ${node.y})`,
        connections: node.connections || []
      };
    });
    
    // Find nearest exit using BFS
    const findNearestExit = (startNodeId, graph) => {
      const queue = [{ nodeId: startNodeId, path: [startNodeId] }];
      const visited = new Set([startNodeId]);
      
      while (queue.length > 0) {
        const { nodeId, path } = queue.shift();
        const node = graph[nodeId];
        
        if (node.type === 'exit') {
          return {
            found: true,
            exitNodeId: nodeId,
            path: path,
            distance: path.length - 1
          };
        }
        
        for (const connectedId of node.connections) {
          if (!visited.has(connectedId) && graph[connectedId]) {
            visited.add(connectedId);
            queue.push({
              nodeId: connectedId,
              path: [...path, connectedId]
            });
          }
        }
      }
      
      return { found: false, exitNodeId: null, path: [], distance: 0 };
    };
    
    // Calculate path to nearest exit
    const pathResult = findNearestExit(nodeId, nodeGraph);
    
    // Get floor map data if available
    // Try multiple matching strategies for floor
    let floorMap = building.maps?.find(map => map.floor === floor.toString());
    
    // If not found with string, try with numeric floor
    if (!floorMap) {
      floorMap = building.maps?.find(map => parseInt(map.floor) === floor);
    }
    
    // If still not found, try to find the first map (fallback)
    if (!floorMap && building.maps && building.maps.length > 0) {
      floorMap = building.maps[0];
    }
    
    if (floorMap) {
      // Show the converted URL
      const imageUrl = (() => {
        if (floorMap.map?.startsWith('http')) {
          return floorMap.map;
        } else if (floorMap.map?.startsWith('/uploads')) {
          return process.env.API_BASE_URL ? `${process.env.API_BASE_URL}${floorMap.map}` : `https://www.alertup.world${floorMap.map}`;
        }
        return null;
      })();
    }
    
    // Construct floor map data - handle both uploaded images and SVG content
    const floorMapData = floorMap ? {
      floor: floorMap.floor,
      map: floorMap.map,
      qrCode: floorMap.qrCode,
      // Handle different image path formats
      imageUrl: (() => {
        if (floorMap.map?.startsWith('http')) {
          return floorMap.map; // Already a full URL
        } else if (floorMap.map?.startsWith('/uploads')) {
          return `${process.env.API_BASE_URL || 'https://www.alertup.world'}${floorMap.map}`; // Relative path
        } else if (floorMap.map?.includes('uploads')) {
          // Convert local path to URL
          const relativePath = floorMap.map.split('uploads')[1];
          return `${process.env.API_BASE_URL || 'https://www.alertup.world'}/uploads${relativePath}`;
        }
        return null;
      })(),
      svgContent: floorMap.map?.includes('<svg') ? floorMap.map : null,
      createdAt: floorMap.createdAt
    } : null;
    
    // Find connections for this node (for backward compatibility)
    const connectedNodes = [];
    for (const connectionId of node.connections) {
      const connectedNode = await Node.findById(connectionId);
      if (connectedNode && connectedNode.floorNumber === floor) {
        connectedNodes.push({
          id: connectedNode._id,
          x: connectedNode.x,
          y: connectedNode.y,
          type: connectedNode.type,
          label: connectedNode.label || `${connectedNode.type} (${connectedNode.x}, ${connectedNode.y})`
        });
      }
    }
    
    // Build route data with pathfinding and map info
    const routeData = {
      qrId,
      buildingId,
      buildingName: building.buildingName,
      floorNumber,
      nodeId: node._id,
      nodeType: node.type,
      nodeLabel: node.label || `${node.type} (${node.x}, ${node.y})`,
      nodePosition: { x: node.x, y: node.y },
      connectedNodes,
      allFloorNodes: floorNodes.map(n => ({
        id: n._id,
        x: n.x,
        y: n.y,
        type: n.type,
        label: n.label || `${n.type} (${n.x}, ${n.y})`,
        connections: n.connections || []
      })),
      // Pathfinding data
      emergencyRoute: {
        found: pathResult.found,
        exitNodeId: pathResult.exitNodeId,
        path: pathResult.path,
        distance: pathResult.distance,
        exitNode: pathResult.found ? nodeGraph[pathResult.exitNodeId] : null
      },
      // Floor map data
      floorMap: floorMapData,
      timestamp: new Date().toISOString(),
      scanCount: (node.scanCount || 0) + 1
    };
    
    // Update scan count
    await Node.findByIdAndUpdate(nodeId, {
      $inc: { scanCount: 1 }
    });
    
    res.status(200).json({
      success: true,
      message: 'Route data retrieved successfully',
      data: routeData
    });
    
  } catch (error) {
    console.error('Error handling QR code scan:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while processing QR code scan',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

export default router;
