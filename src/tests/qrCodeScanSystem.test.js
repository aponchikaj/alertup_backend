import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../server.js';
import BUILDINGS from '../../src/models/building.model.js';
import USERS from '../../src/models/user.model.js';
import Node from '../../src/models/node.model.js';

describe('QR Code Frontend URL and Scan System', () => {
  let testUser;
  let testBuilding;
  let authToken;
  let testNode;

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

    // Create test node
    testNode = new Node({
      buildingId: testBuilding._id,
      floorNumber: 1,
      x: 100,
      y: 200,
      type: 'exit',
      connections: [],
      scanCount: 0
    });
    await testNode.save();
  });

  afterAll(async () => {
    // Clean up test data
    await Node.deleteMany({});
    await BUILDINGS.deleteMany({});
    await USERS.deleteMany({});
    await mongoose.connection.close();
  });

  describe('QR Code Generation with Frontend URL', () => {
    it('should generate QR code pointing to localhost:5173/scan/route/', async () => {
      const response = await request(app)
        .post('/api/qr/generate')
        .set('Cookie', `token=${authToken}`)
        .send({
          nodeId: testNode._id.toString(),
          buildingId: testBuilding._id.toString(),
          floorNumber: 1,
          format: 'svg'
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.qrData).toContain('http://localhost:5173/scan/route/qr_');
      expect(response.body.data.qrData).toContain(testBuilding._id.toString());
      expect(response.body.data.qrData).toContain('1');
      expect(response.body.data.qrData).toContain(testNode._id.toString());
    });

    it('should generate PNG QR code pointing to localhost:5173/scan/route/', async () => {
      const response = await request(app)
        .post('/api/qr/generate')
        .set('Cookie', `token=${authToken}`)
        .send({
          nodeId: testNode._id.toString(),
          buildingId: testBuilding._id.toString(),
          floorNumber: 1,
          format: 'png'
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.qrData).toContain('http://localhost:5173/scan/route/qr_');
      expect(response.body.data.format).toBe('png');
    });

    it('should use custom CLIENT_SCAN_QR_URL if set', async () => {
      // Temporarily set environment variable
      const originalUrl = process.env.CLIENT_SCAN_QR_URL;
      process.env.CLIENT_SCAN_QR_URL = 'https://myapp.com';

      const response = await request(app)
        .post('/api/qr/generate')
        .set('Cookie', `token=${authToken}`)
        .send({
          nodeId: testNode._id.toString(),
          buildingId: testBuilding._id.toString(),
          floorNumber: 1,
          format: 'svg'
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.qrData).toContain('https://myapp.com/scan/route/qr_');

      // Restore original value
      if (originalUrl) {
        process.env.CLIENT_SCAN_QR_URL = originalUrl;
      } else {
        delete process.env.CLIENT_SCAN_QR_URL;
      }
    });
  });

  describe('QR Code Scan API', () => {
    it('should handle QR code scan requests', async () => {
      const qrId = `qr_${testBuilding._id}_1_${testNode._id}`;
      
      const response = await request(app)
        .get(`/api/qr/scan/route/${qrId}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Route data retrieved successfully');
      expect(response.body.data.qrId).toBe(qrId);
      expect(response.body.data.buildingId).toBe(testBuilding._id.toString());
      expect(response.body.data.buildingName).toBe('Test Building');
      expect(response.body.data.floorNumber).toBe(1);
      expect(response.body.data.nodeId).toBe(testNode._id.toString());
      expect(response.body.data.nodeType).toBe('exit');
      expect(response.body.data.nodePosition).toEqual({ x: 100, y: 200 });
      expect(response.body.data.scanCount).toBe(1);
    });

    it('should return 400 for invalid QR code format', async () => {
      const response = await request(app)
        .get('/api/qr/scan/route/invalid-qr-code')
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Invalid QR code format');
    });

    it('should return 404 for non-existent node', async () => {
      const qrId = `qr_${testBuilding._id}_1_${new mongoose.Types.ObjectId()}`;
      
      const response = await request(app)
        .get(`/api/qr/scan/route/${qrId}`)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Node not found');
    });

    it('should return 404 for non-existent building', async () => {
      const qrId = `qr_${new mongoose.Types.ObjectId()}_1_${testNode._id}`;
      
      const response = await request(app)
        .get(`/api/qr/scan/route/${qrId}`)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Building not found');
    });

    it('should return 400 for invalid ID format', async () => {
      const qrId = `qr_invalid-id_1_${testNode._id}`;
      
      const response = await request(app)
        .get(`/api/qr/scan/route/${qrId}`)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Invalid building or node ID format');
    });

    it('should include connected nodes in response', async () => {
      // Create a connected node
      const connectedNode = new Node({
        buildingId: testBuilding._id,
        floorNumber: 1,
        x: 300,
        y: 400,
        type: 'path',
        connections: [testNode._id.toString()]
      });
      await connectedNode.save();

      // Add connection to test node
      await Node.findByIdAndUpdate(testNode._id, {
        $push: { connections: connectedNode._id.toString() }
      });

      const qrId = `qr_${testBuilding._id}_1_${testNode._id}`;
      
      const response = await request(app)
        .get(`/api/qr/scan/route/${qrId}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.connectedNodes).toHaveLength(1);
      expect(response.body.data.connectedNodes[0].id).toBe(connectedNode._id.toString());
      expect(response.body.data.connectedNodes[0].type).toBe('path');
      expect(response.body.data.connectedNodes[0].x).toBe(300);
      expect(response.body.data.connectedNodes[0].y).toBe(400);
    });

    it('should include all floor nodes in response', async () => {
      // Create another node on the same floor
      const anotherNode = new Node({
        buildingId: testBuilding._id,
        floorNumber: 1,
        x: 500,
        y: 600,
        type: 'stairs',
        connections: []
      });
      await anotherNode.save();

      const qrId = `qr_${testBuilding._id}_1_${testNode._id}`;
      
      const response = await request(app)
        .get(`/api/qr/scan/route/${qrId}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.allFloorNodes).toHaveLength(2);
      expect(response.body.data.allFloorNodes.map(n => n.id)).toContain(testNode._id.toString());
      expect(response.body.data.allFloorNodes.map(n => n.id)).toContain(anotherNode._id.toString());
    });

    it('should increment scan count on each scan', async () => {
      const qrId = `qr_${testBuilding._id}_1_${testNode._id}`;
      
      // First scan
      const response1 = await request(app)
        .get(`/api/qr/scan/route/${qrId}`)
        .expect(200);

      expect(response1.body.data.scanCount).toBe(1);

      // Second scan
      const response2 = await request(app)
        .get(`/api/qr/scan/route/${qrId}`)
        .expect(200);

      expect(response2.body.data.scanCount).toBe(2);

      // Verify in database
      const updatedNode = await Node.findById(testNode._id);
      expect(updatedNode.scanCount).toBe(2);
    });
  });

  describe('QR Code File Creation', () => {
    it('should create SVG file with correct URL', async () => {
      const response = await request(app)
        .post('/api/qr/generate')
        .set('Cookie', `token=${authToken}`)
        .send({
          nodeId: testNode._id.toString(),
          buildingId: testBuilding._id.toString(),
          floorNumber: 1,
          format: 'svg'
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.filename).toBeTruthy();
      expect(response.body.data.filename).endsWith('.svg');
      expect(response.body.data.svgContent).toContain('http://localhost:5173/scan/route/qr_');
    });

    it('should create PNG file with correct URL', async () => {
      const response = await request(app)
        .post('/api/qr/generate')
        .set('Cookie', `token=${authToken}`)
        .send({
          nodeId: testNode._id.toString(),
          buildingId: testBuilding._id.toString(),
          floorNumber: 1,
          format: 'png'
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.filename).toBeTruthy();
      expect(response.body.data.filename).endsWith('.png');
      expect(response.body.data.qrData).toContain('http://localhost:5173/scan/route/qr_');
    });
  });

  describe('Integration Test: Generate → Scan', () => {
    it('should work end-to-end: generate QR code and scan it', async () => {
      // Step 1: Generate QR code
      const generateResponse = await request(app)
        .post('/api/qr/generate')
        .set('Cookie', `token=${authToken}`)
        .send({
          nodeId: testNode._id.toString(),
          buildingId: testBuilding._id.toString(),
          floorNumber: 1,
          format: 'svg'
        })
        .expect(200);

      expect(generateResponse.body.success).toBe(true);
      const qrData = generateResponse.body.data.qrData;
      
      // Extract QR ID from the URL
      const qrIdMatch = qrData.match(/scan\/route\/(.+)$/);
      expect(qrIdMatch).toBeTruthy();
      const qrId = qrIdMatch[1];

      // Step 2: Scan the QR code
      const scanResponse = await request(app)
        .get(`/api/qr/scan/route/${qrId}`)
        .expect(200);

      expect(scanResponse.body.success).toBe(true);
      expect(scanResponse.body.data.nodeId).toBe(testNode._id.toString());
      expect(scanResponse.body.data.buildingId).toBe(testBuilding._id.toString());
      expect(scanResponse.body.data.floorNumber).toBe(1);
    });
  });
});
