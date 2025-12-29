import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../server.js';
import BUILDINGS from '../../src/models/building.model.js';
import USERS from '../../src/models/user.model.js';
import Node from '../../src/models/node.model.js';

describe('Node Management API', () => {
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
  });

  afterAll(async () => {
    // Clean up test data
    await Node.deleteMany({});
    await BUILDINGS.deleteMany({});
    await USERS.deleteMany({});
    await mongoose.connection.close();
  });

  describe('Node Creation', () => {
    it('should create a new node', async () => {
      const nodeData = {
        buildingId: testBuilding._id.toString(),
        floorNumber: 1,
        x: 100,
        y: 200,
        type: 'exit',
        label: 'Main Exit'
      };

      const response = await request(app)
        .post('/api/nodes')
        .set('Cookie', `token=${authToken}`)
        .send(nodeData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.node.type).toBe('exit');
      expect(response.body.node.x).toBe(100);
      expect(response.body.node.y).toBe(200);
      expect(response.body.node.label).toBe('Main Exit');

      testNodes.push(response.body.node);
    });

    it('should validate node types', async () => {
      const nodeData = {
        buildingId: testBuilding._id.toString(),
        floorNumber: 1,
        x: 100,
        y: 200,
        type: 'invalid-type',
        label: 'Invalid Node'
      };

      const response = await request(app)
        .post('/api/nodes')
        .set('Cookie', `token=${authToken}`)
        .send(nodeData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('Type must be path, exit, or stairs');
    });

    it('should require authentication', async () => {
      const nodeData = {
        buildingId: testBuilding._id.toString(),
        floorNumber: 1,
        x: 100,
        y: 200,
        type: 'exit',
        label: 'Main Exit'
      };

      const response = await request(app)
        .post('/api/nodes')
        .send(nodeData)
        .expect(401);

      expect(response.body.success).toBe(false);
    });
  });

  describe('Node Retrieval', () => {
    it('should get all nodes for a building', async () => {
      const response = await request(app)
        .get(`/api/nodes/building/${testBuilding._id}`)
        .set('Cookie', `token=${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.nodes).toHaveLength(1);
      expect(response.body.nodes[0].type).toBe('exit');
    });

    it('should filter nodes by floor', async () => {
      // Create a node on floor 2
      const floor2Node = await request(app)
        .post('/api/nodes')
        .set('Cookie', `token=${authToken}`)
        .send({
          buildingId: testBuilding._id.toString(),
          floorNumber: 2,
          x: 300,
          y: 400,
          type: 'stairs',
          label: 'Stairs to Floor 2'
        });

      testNodes.push(floor2Node.body.node);

      // Get all nodes
      const response = await request(app)
        .get(`/api/nodes/building/${testBuilding._id}`)
        .set('Cookie', `token=${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.nodes).toHaveLength(2);
      
      const floor1Nodes = response.body.nodes.filter(n => n.floorNumber === 1);
      const floor2Nodes = response.body.nodes.filter(n => n.floorNumber === 2);
      
      expect(floor1Nodes).toHaveLength(1);
      expect(floor2Nodes).toHaveLength(1);
    });
  });

  describe('Node Updates', () => {
    it('should update node position', async () => {
      const nodeId = testNodes[0]._id;
      const updateData = {
        x: 150,
        y: 250,
        label: 'Updated Main Exit'
      };

      const response = await request(app)
        .put(`/api/nodes/${nodeId}`)
        .set('Cookie', `token=${authToken}`)
        .send(updateData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.node.x).toBe(150);
      expect(response.body.node.y).toBe(250);
      expect(response.body.node.label).toBe('Updated Main Exit');
    });

    it('should update node type', async () => {
      const nodeId = testNodes[0]._id;
      const updateData = {
        type: 'path'
      };

      const response = await request(app)
        .put(`/api/nodes/${nodeId}`)
        .set('Cookie', `token=${authToken}`)
        .send(updateData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.node.type).toBe('path');
    });

    it('should require ownership for updates', async () => {
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

      // Try to update with original user
      const response = await request(app)
        .put(`/api/nodes/${otherNode._id}`)
        .set('Cookie', `token=${authToken}`)
        .send({ x: 200, y: 200 })
        .expect(404);

      expect(response.body.success).toBe(false);
    });
  });

  describe('Node Connections', () => {
    it('should connect two nodes', async () => {
      const response = await request(app)
        .post('/api/nodes/connect')
        .set('Cookie', `token=${authToken}`)
        .send({
          fromNodeId: testNodes[0]._id,
          toNodeId: testNodes[1]._id
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('connected successfully');
    });

    it('should prevent self-connection', async () => {
      const response = await request(app)
        .post('/api/nodes/connect')
        .set('Cookie', `token=${authToken}`)
        .send({
          fromNodeId: testNodes[0]._id,
          toNodeId: testNodes[0]._id
        })
        .expect(400);

      expect(response.body.success).toBe(false);
    });

    it('should validate node existence for connections', async () => {
      const response = await request(app)
        .post('/api/nodes/connect')
        .set('Cookie', `token=${authToken}`)
        .send({
          fromNodeId: testNodes[0]._id,
          toNodeId: new mongoose.Types.ObjectId().toString()
        })
        .expect(404);

      expect(response.body.success).toBe(false);
    });
  });

  describe('Node Deletion', () => {
    it('should delete a node', async () => {
      const nodeIdToDelete = testNodes[1]._id;

      const response = await request(app)
        .delete(`/api/nodes/${nodeIdToDelete}`)
        .set('Cookie', `token=${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('deleted successfully');

      // Verify node is deleted
      const deletedNode = await Node.findById(nodeIdToDelete);
      expect(deletedNode).toBeNull();
    });

    it('should handle deletion of non-existent node', async () => {
      const response = await request(app)
        .delete(`/api/nodes/${new mongoose.Types.ObjectId().toString()}`)
        .set('Cookie', `token=${authToken}`)
        .expect(404);

      expect(response.body.success).toBe(false);
    });

    it('should require ownership for deletion', async () => {
      // Create another user's node
      const otherUser = new USERS({
        username: 'deleteuser',
        email: 'delete@example.com',
        password: 'password123',
        verified: true
      });
      await otherUser.save();

      const otherBuilding = new BUILDINGS({
        buildingName: 'Delete Building',
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

      // Try to delete with original user
      const response = await request(app)
        .delete(`/api/nodes/${otherNode._id}`)
        .set('Cookie', `token=${authToken}`)
        .expect(404);

      expect(response.body.success).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid node ID format', async () => {
      const response = await request(app)
        .get('/api/nodes/invalid-id')
        .set('Cookie', `token=${authToken}`)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('Invalid node ID');
    });

    it('should handle missing required fields', async () => {
      const response = await request(app)
        .post('/api/nodes')
        .set('Cookie', `token=${authToken}`)
        .send({
          buildingId: testBuilding._id.toString(),
          // Missing floorNumber, x, y, type
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('validation errors');
    });
  });
});
