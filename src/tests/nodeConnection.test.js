import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../server.js';
import BUILDINGS from '../../src/models/building.model.js';
import USERS from '../../src/models/user.model.js';
import Node from '../../src/models/node.model.js';

describe('Node Connection API', () => {
  let testUser;
  let testBuilding;
  let authToken;
  let testNodes = [];

  beforeAll(async () => {
    // Connect to test database
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGO_TEST_STRING || 'mongodb://localhost:27017/alertup-test');
    }

    // Create test user
    testUser = new USERS({
      username: 'testuser',
      email: 'test@example.com',
      password: 'password123',
      verified: true
    });
    await testUser.save();

    // Login to get token
    const loginResponse = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'test@example.com',
        password: 'password123'
      });

    authToken = loginResponse.body.token;

    // Create test building
    testBuilding = new BUILDINGS({
      buildingName: 'Test Building',
      owner: testUser._id,
      floors: 2,
      maps: [
        { floor: '1', map: null, qrCode: 'test-qr-1', scanned: 0 },
        { floor: '2', map: null, qrCode: 'test-qr-2', scanned: 0 }
      ]
    });
    await testBuilding.save();

    // Create test nodes
    const node1 = new Node({
      buildingId: testBuilding._id,
      floorNumber: 1,
      x: 100,
      y: 200,
      type: 'exit',
      connections: []
    });
    await node1.save();
    testNodes.push(node1);

    const node2 = new Node({
      buildingId: testBuilding._id,
      floorNumber: 1,
      x: 300,
      y: 400,
      type: 'path',
      connections: []
    });
    await node2.save();
    testNodes.push(node2);
  });

  afterAll(async () => {
    // Clean up test data
    await Node.deleteMany({});
    await BUILDINGS.deleteMany({});
    await USERS.deleteMany({});
    await mongoose.connection.close();
  });

  describe('POST /api/nodes/connect', () => {
    it('should connect two nodes successfully', async () => {
      const response = await request(app)
        .post('/api/nodes/connect')
        .set('Cookie', `token=${authToken}`)
        .send({
          fromNodeId: testNodes[0]._id.toString(),
          toNodeId: testNodes[1]._id.toString()
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Nodes connected successfully');
      expect(response.body.data.fromNode.connections).toContain(testNodes[1]._id.toString());
      expect(response.body.data.toNode.connections).toContain(testNodes[0]._id.toString());
    });

    it('should require both node IDs', async () => {
      const response = await request(app)
        .post('/api/nodes/connect')
        .set('Cookie', `token=${authToken}`)
        .send({
          fromNodeId: testNodes[0]._id.toString()
          // Missing toNodeId
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Both fromNodeId and toNodeId are required');
    });

    it('should prevent self-connection', async () => {
      const response = await request(app)
        .post('/api/nodes/connect')
        .set('Cookie', `token=${authToken}`)
        .send({
          fromNodeId: testNodes[0]._id.toString(),
          toNodeId: testNodes[0]._id.toString()
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Cannot connect a node to itself');
    });

    it('should validate node ID format', async () => {
      const response = await request(app)
        .post('/api/nodes/connect')
        .set('Cookie', `token=${authToken}`)
        .send({
          fromNodeId: 'invalid-id',
          toNodeId: testNodes[1]._id.toString()
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Invalid node ID format');
    });

    it('should handle non-existent nodes', async () => {
      const response = await request(app)
        .post('/api/nodes/connect')
        .set('Cookie', `token=${authToken}`)
        .send({
          fromNodeId: testNodes[0]._id.toString(),
          toNodeId: new mongoose.Types.ObjectId().toString()
        })
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('One or both nodes not found');
    });

    it('should prevent connecting nodes from different buildings', async () => {
      // Create another building and node
      const otherBuilding = new BUILDINGS({
        buildingName: 'Other Building',
        owner: testUser._id,
        floors: 1
      });
      await otherBuilding.save();

      const otherNode = new Node({
        buildingId: otherBuilding._id,
        floorNumber: 1,
        x: 100,
        y: 100,
        type: 'exit',
        connections: []
      });
      await otherNode.save();

      const response = await request(app)
        .post('/api/nodes/connect')
        .set('Cookie', `token=${authToken}`)
        .send({
          fromNodeId: testNodes[0]._id.toString(),
          toNodeId: otherNode._id.toString()
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Nodes must be in the same building');
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/nodes/connect')
        .send({
          fromNodeId: testNodes[0]._id.toString(),
          toNodeId: testNodes[1]._id.toString()
        })
        .expect(401);

      expect(response.body.success).toBe(false);
    });

    it('should require building ownership', async () => {
      // Create another user and building
      const otherUser = new USERS({
        username: 'otheruser',
        email: 'other@example.com',
        password: 'password123',
        verified: true
      });
      await otherUser.save();

      const otherBuilding = new BUILDINGS({
        buildingName: 'Other Building',
        owner: otherUser._id,
        floors: 1
      });
      await otherBuilding.save();

      const otherNode = new Node({
        buildingId: otherBuilding._id,
        floorNumber: 1,
        x: 100,
        y: 100,
        type: 'exit',
        connections: []
      });
      await otherNode.save();

      // Try to connect with original user
      const response = await request(app)
        .post('/api/nodes/connect')
        .set('Cookie', `token=${authToken}`)
        .send({
          fromNodeId: otherNode._id.toString(),
          toNodeId: otherNode._id.toString()
        })
        .expect(404);

      expect(response.body.success).toBe(false);
    });

    it('should prevent duplicate connections', async () => {
      // First connection should succeed
      await request(app)
        .post('/api/nodes/connect')
        .set('Cookie', `token=${authToken}`)
        .send({
          fromNodeId: testNodes[0]._id.toString(),
          toNodeId: testNodes[1]._id.toString()
        })
        .expect(200);

      // Second connection should fail
      const response = await request(app)
        .post('/api/nodes/connect')
        .set('Cookie', `token=${authToken}`)
        .send({
          fromNodeId: testNodes[0]._id.toString(),
          toNodeId: testNodes[1]._id.toString()
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Nodes are already connected');
    });

    it('should create bidirectional connections', async () => {
      // Create fresh nodes for this test
      const node3 = new Node({
        buildingId: testBuilding._id,
        floorNumber: 1,
        x: 500,
        y: 600,
        type: 'stairs',
        connections: []
      });
      await node3.save();

      const node4 = new Node({
        buildingId: testBuilding._id,
        floorNumber: 1,
        x: 700,
        y: 800,
        type: 'path',
        connections: []
      });
      await node4.save();

      const response = await request(app)
        .post('/api/nodes/connect')
        .set('Cookie', `token=${authToken}`)
        .send({
          fromNodeId: node3._id.toString(),
          toNodeId: node4._id.toString()
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.fromNode.connections).toContain(node4._id.toString());
      expect(response.body.data.toNode.connections).toContain(node3._id.toString());

      // Verify in database
      const updatedNode3 = await Node.findById(node3._id);
      const updatedNode4 = await Node.findById(node4._id);
      
      expect(updatedNode3.connections).toContain(node4._id.toString());
      expect(updatedNode4.connections).toContain(node3._id.toString());
    });
  });

  describe('Node Connection Integration', () => {
    it('should maintain connections after node updates', async () => {
      // Connect nodes first
      await request(app)
        .post('/api/nodes/connect')
        .set('Cookie', `token=${authToken}`)
        .send({
          fromNodeId: testNodes[0]._id.toString(),
          toNodeId: testNodes[1]._id.toString()
        })
        .expect(200);

      // Update one node
      const response = await request(app)
        .put(`/api/nodes/${testNodes[0]._id}`)
        .set('Cookie', `token=${authToken}`)
        .send({
          x: 150,
          y: 250,
          label: 'Updated Exit'
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.node.connections).toContain(testNodes[1]._id.toString());
    });

    it('should remove connections when node is deleted', async () => {
      // Create a new node to delete
      const nodeToDelete = new Node({
        buildingId: testBuilding._id,
        floorNumber: 1,
        x: 900,
        y: 1000,
        type: 'exit',
        connections: []
      });
      await nodeToDelete.save();

      // Connect it to existing node
      await request(app)
        .post('/api/nodes/connect')
        .set('Cookie', `token=${authToken}`)
        .send({
          fromNodeId: testNodes[0]._id.toString(),
          toNodeId: nodeToDelete._id.toString()
        })
        .expect(200);

      // Delete the node
      await request(app)
        .delete(`/api/nodes/${nodeToDelete._id}`)
        .set('Cookie', `token=${authToken}`)
        .expect(200);

      // Check that the connection was removed from the other node
      const remainingNode = await Node.findById(testNodes[0]._id);
      expect(remainingNode.connections).not.toContain(nodeToDelete._id.toString());
    });
  });
});
