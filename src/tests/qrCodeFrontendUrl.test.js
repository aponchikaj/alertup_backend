import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../server.js';
import BUILDINGS from '../../src/models/building.model.js';
import USERS from '../../src/models/user.model.js';
import Node from '../../src/models/node.model.js';

describe('QR Code Frontend URL Verification', () => {
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
      floors: 1,
      maps: [
        { floor: '1', map: null, qrCode: 'test-qr-1', scanned: 0 }
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
      connections: []
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

  describe('QR Code URL Generation', () => {
    it('should generate QR code pointing to localhost:5173', async () => {
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
      expect(response.body.data.qrData).toContain('http://localhost:5173');
      expect(response.body.data.qrData).toContain('/route/qr_');
      expect(response.body.data.qrData).toContain(testBuilding._id.toString());
      expect(response.body.data.qrData).toContain('1');
      expect(response.body.data.qrData).toContain(testNode._id.toString());
    });

    it('should generate PNG QR code pointing to localhost:5173', async () => {
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
      expect(response.body.data.qrData).toContain('http://localhost:5173');
      expect(response.body.data.qrData).toContain('/route/qr_');
    });

    it('should use environment variable CLIENT_SCAN_QR_URL if set', async () => {
      // Temporarily set environment variable
      const originalUrl = process.env.CLIENT_SCAN_QR_URL;
      process.env.CLIENT_SCAN_QR_URL = 'https://custom-domain.com';

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
      expect(response.body.data.qrData).toContain('https://custom-domain.com');

      // Restore original value
      if (originalUrl) {
        process.env.CLIENT_SCAN_QR_URL = originalUrl;
      } else {
        delete process.env.CLIENT_SCAN_SCAN_QR_URL;
      }
    });

    it('should create QR code file with correct URL in SVG content', async () => {
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
      expect(response.body.data.svgContent).toContain('http://localhost:5173');
      
      // Check if the SVG content contains the QR data
      const expectedUrl = `http://localhost:5173/route/qr_${testBuilding._id}_1_${testNode._id}`;
      expect(response.body.data.svgContent).toContain(expectedUrl);
    });

    it('should serve QR code file with correct URL', async () => {
      // Generate QR code first
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

      const filename = generateResponse.body.data.filename;

      // Access the file directly
      const fileResponse = await request(app)
        .get(`/uploads/qr-codes/${filename}`)
        .expect(200);

      expect(fileResponse.text).toContain('http://localhost:5173');
      expect(fileResponse.text).toContain(testBuilding._id.toString());
    });
  });

  describe('QR Code File Verification', () => {
    it('should create downloadable SVG file', async () => {
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
      expect(response.body.data.url).toContain('/uploads/qr-codes/');
      expect(response.body.data.publicUrl).toContain('http://localhost:3001/uploads/qr-codes/');
    });

    it('should create downloadable PNG file', async () => {
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
      expect(response.body.data.url).toContain('/uploads/qr-codes/');
    });
  });
});
