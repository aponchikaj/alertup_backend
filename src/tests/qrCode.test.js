import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../server.js';
import BUILDINGS from '../../src/models/building.model.js';
import USERS from '../../src/models/user.model.js';
import QRCode from '../../src/models/qrcode.model.js';

describe('QR Code Routes', () => {
  let testUser;
  let testBuilding;
  let authToken;

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
  });

  afterAll(async () => {
    // Clean up test data
    await BUILDINGS.deleteMany({});
    await QRCode.deleteMany({});
    await USERS.deleteMany({});
    await mongoose.connection.close();
  });

  describe('POST /api/qr/generate', () => {
    it('should generate QR code in PNG format', async () => {
      const qrRequest = {
        nodeId: 'test-node-id',
        buildingId: testBuilding._id.toString(),
        floorNumber: 1,
        format: 'png'
      };

      const response = await request(app)
        .post('/api/qr/generate')
        .set('Cookie', `token=${authToken}`)
        .send(qrRequest)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.format).toBe('png');
      expect(response.body.data.filename).toBeTruthy();
      expect(response.body.data.url).toBeTruthy();
      expect(response.body.data.qrData).toContain('qr_');
    });

    it('should generate QR code in SVG format', async () => {
      const qrRequest = {
        nodeId: 'test-node-id',
        buildingId: testBuilding._id.toString(),
        floorNumber: 1,
        format: 'svg'
      };

      const response = await request(app)
        .post('/api/qr/generate')
        .set('Cookie', `token=${authToken}`)
        .send(qrRequest)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.format).toBe('svg');
      expect(response.body.data.svgContent).toContain('<svg');
      expect(response.body.data.qrData).toContain('qr_');
    });

    it('should require authentication', async () => {
      const qrRequest = {
        nodeId: 'test-node-id',
        buildingId: testBuilding._id.toString(),
        floorNumber: 1,
        format: 'png'
      };

      const response = await request(app)
        .post('/api/qr/generate')
        .send(qrRequest)
        .expect(401);

      expect(response.body.success).toBe(false);
    });

    it('should require ownership', async () => {
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

      const qrRequest = {
        nodeId: 'test-node-id',
        buildingId: otherBuilding._id.toString(),
        floorNumber: 1,
        format: 'png'
      };

      const response = await request(app)
        .post('/api/qr/generate')
        .set('Cookie', `token=${authToken}`)
        .send(qrRequest)
        .expect(404);

      expect(response.body.success).toBe(false);
    });

    it('should validate required fields', async () => {
      const qrRequest = {
        nodeId: 'test-node-id',
        // missing buildingId and floorNumber
        format: 'png'
      };

      const response = await request(app)
        .post('/api/qr/generate')
        .set('Cookie', `token=${authToken}`)
        .send(qrRequest)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('Missing required fields');
    });

    it('should validate format', async () => {
      const qrRequest = {
        nodeId: 'test-node-id',
        buildingId: testBuilding._id.toString(),
        floorNumber: 1,
        format: 'invalid'
      };

      const response = await request(app)
        .post('/api/qr/generate')
        .set('Cookie', `token=${authToken}`)
        .send(qrRequest)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('Invalid format');
    });
  });
});
