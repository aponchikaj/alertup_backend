import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../server.js';
import BUILDINGS from '../../src/models/building.model.js';
import USERS from '../../src/models/user.model.js';
import Node from '../../src/models/node.model.js';

describe('Node Management API - Complete Fix Verification', () => {
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

  describe('POST /api/nodes/connect - Fixed Format', () => {
    beforeEach(async () => {
      // Create test nodes for each test
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

    afterEach(async () => {
      // Clean up nodes after each test
      await Node.deleteMany({});
      testNodes = [];
    });

    it('should connect nodes with new format (buildingId, node1Id, node2Id)', async () => {
      const response = await request(app)
        .post('/api/nodes/connect')
        .set('Cookie', `token=${authToken}`)
        .send({
          buildingId: testBuilding._id.toString(),
          node1Id: testNodes[0]._id.toString(),
          node2Id: testNodes[1]._id.toString()
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Nodes connected successfully');
      expect(response.body.data.connection.buildingId).toBe(testBuilding._id.toString());
      expect(response.body.data.connection.node1Id).toBe(testNodes[0]._id.toString());
      expect(response.body.data.connection.node2Id).toBe(testNodes[1]._id.toString());
      expect(response.body.data.connection.node1.connections).toContain(testNodes[1]._id.toString());
      expect(response.body.data.connection.node2.connections).toContain(testNodes[0]._id.toString());
    });

    it('should return 400 if missing buildingId', async () => {
      const response = await request(app)
        .post('/api/nodes/connect')
        .set('Cookie', `token=${authToken}`)
        .send({
          node1Id: testNodes[0]._id.toString(),
          node2Id: testNodes[1]._id.toString()
          // Missing buildingId
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('buildingId, node1Id, and node2Id are required');
    });

    it('should return 400 if missing node1Id', async () => {
      const response = await request(app)
        .post('/api/nodes/connect')
        .set('Cookie', `token=${authToken}`)
        .send({
          buildingId: testBuilding._id.toString(),
          node2Id: testNodes[1]._id.toString()
          // Missing node1Id
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('buildingId, node1Id, and node2Id are required');
    });

    it('should return 400 if missing node2Id', async () => {
      const response = await request(app)
        .post('/api/nodes/connect')
        .set('Cookie', `token=${authToken}`)
        .send({
          buildingId: testBuilding._id.toString(),
          node1Id: testNodes[0]._id.toString()
          // Missing node2Id
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('buildingId, node1Id, and node2Id are required');
    });

    it('should not return 500 for valid requests', async () => {
      const response = await request(app)
        .post('/api/nodes/connect')
        .set('Cookie', `token=${authToken}`)
        .send({
          buildingId: testBuilding._id.toString(),
          node1Id: testNodes[0]._id.toString(),
          node2Id: testNodes[1]._id.toString()
        });

      expect(response.status).not.toBe(500);
      expect(response.body.success).toBe(true);
    });
  });

  describe('PUT /api/nodes/:id - Node Updates', () => {
    beforeEach(async () => {
      const testNode = new Node({
        buildingId: testBuilding._id,
        floorNumber: 1,
        x: 100,
        y: 200,
        type: 'exit',
        connections: []
      });
      await testNode.save();
      testNodes.push(testNode);
    });

    afterEach(async () => {
      await Node.deleteMany({});
      testNodes = [];
    });

    it('should update node coordinates', async () => {
      const response = await request(app)
        .put(`/api/nodes/${testNodes[0]._id}`)
        .set('Cookie', `token=${authToken}`)
        .send({
          x: 150,
          y: 250
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Node updated successfully');
      expect(response.body.node.x).toBe(150);
      expect(response.body.node.y).toBe(250);
      expect(response.body.node.updatedAt).toBeTruthy();
    });

    it('should update node type and label', async () => {
      const response = await request(app)
        .put(`/api/nodes/${testNodes[0]._id}`)
        .set('Cookie', `token=${authToken}`)
        .send({
          type: 'stairs',
          label: 'Updated Stairs'
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.node.type).toBe('stairs');
      expect(response.body.node.label).toBe('Updated Stairs');
    });

    it('should validate coordinates', async () => {
      const response = await request(app)
        .put(`/api/nodes/${testNodes[0]._id}`)
        .set('Cookie', `token=${authToken}`)
        .send({
          x: -10, // Invalid negative coordinate
          y: 250
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Invalid x coordinate');
    });

    it('should validate node type', async () => {
      const response = await request(app)
        .put(`/api/nodes/${testNodes[0]._id}`)
        .set('Cookie', `token=${authToken}`)
        .send({
          type: 'invalid-type'
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Type must be path, exit, or stairs');
    });

    it('should not return 500 for valid updates', async () => {
      const response = await request(app)
        .put(`/api/nodes/${testNodes[0]._id}`)
        .set('Cookie', `token=${authToken}`)
        .send({
          x: 200,
          y: 300
        });

      expect(response.status).not.toBe(500);
      expect(response.body.success).toBe(true);
    });
  });

  describe('DELETE /api/nodes/:id - Node Deletion', () => {
    beforeEach(async () => {
      const testNode = new Node({
        buildingId: testBuilding._id,
        floorNumber: 1,
        x: 100,
        y: 200,
        type: 'exit',
        connections: []
      });
      await testNode.save();
      testNodes.push(testNode);
    });

    afterEach(async () => {
      await Node.deleteMany({});
      testNodes = [];
    });

    it('should delete node and return success', async () => {
      const response = await request(app)
        .delete(`/api/nodes/${testNodes[0]._id}`)
        .set('Cookie', `token=${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Node deleted successfully');
      expect(response.body.data.deletedNodeId).toBe(testNodes[0]._id.toString());
      expect(response.body.data.buildingId).toBe(testBuilding._id.toString());

      // Verify node is deleted
      const deletedNode = await Node.findById(testNodes[0]._id);
      expect(deletedNode).toBeNull();
    });

    it('should remove connections from other nodes', async () => {
      // Create a second node and connect them
      const node2 = new Node({
        buildingId: testBuilding._id,
        floorNumber: 1,
        x: 300,
        y: 400,
        type: 'path',
        connections: [testNodes[0]._id.toString()]
      });
      await node2.save();

      // Delete the first node
      const response = await request(app)
        .delete(`/api/nodes/${testNodes[0]._id}`)
        .set('Cookie', `token=${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);

      // Check that connection was removed from node2
      const updatedNode2 = await Node.findById(node2._id);
      expect(updatedNode2.connections).not.toContain(testNodes[0]._id.toString());
    });

    it('should return 404 for non-existent node', async () => {
      const response = await request(app)
        .delete(`/api/nodes/${new mongoose.Types.ObjectId().toString()}`)
        .set('Cookie', `token=${authToken}`)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Node not found');
    });

    it('should not return 500 for valid deletion', async () => {
      const response = await request(app)
        .delete(`/api/nodes/${testNodes[0]._id}`)
        .set('Cookie', `token=${authToken}`);

      expect(response.status).not.toBe(500);
      expect(response.body.success).toBe(true);
    });
  });

  describe('Authentication and Authorization', () => {
    beforeEach(async () => {
      const testNode = new Node({
        buildingId: testBuilding._id,
        floorNumber: 1,
        x: 100,
        y: 200,
        type: 'exit',
        connections: []
      });
      await testNode.save();
      testNodes.push(testNode);
    });

    afterEach(async () => {
      await Node.deleteMany({});
      testNodes = [];
    });

    it('should require authentication for all operations', async () => {
      // Test connect without auth
      const connectResponse = await request(app)
        .post('/api/nodes/connect')
        .send({
          buildingId: testBuilding._id.toString(),
          node1Id: testNodes[0]._id.toString(),
          node2Id: testNodes[0]._id.toString()
        })
        .expect(401);

      // Test update without auth
      const updateResponse = await request(app)
        .put(`/api/nodes/${testNodes[0]._id}`)
        .send({ x: 200, y: 300 })
        .expect(401);

      // Test delete without auth
      const deleteResponse = await request(app)
        .delete(`/api/nodes/${testNodes[0]._id}`)
        .expect(401);

      expect(connectResponse.body.success).toBe(false);
      expect(updateResponse.body.success).toBe(false);
      expect(deleteResponse.body.success).toBe(false);
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

      // Try to update other user's node
      const updateResponse = await request(app)
        .put(`/api/nodes/${otherNode._id}`)
        .set('Cookie', `token=${authToken}`)
        .send({ x: 200, y: 300 })
        .expect(403);

      expect(updateResponse.body.success).toBe(false);
      expect(updateResponse.body.message).toContain('Access denied');
    });
  });
});
