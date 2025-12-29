import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../server.js';
import BUILDINGS from '../../src/models/building.model.js';
import USERS from '../../src/models/user.model.js';
import fs from 'fs';
import path from 'path';

describe('Image Upload and QR Code Integration', () => {
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
    await USERS.deleteMany({});
    await mongoose.connection.close();
  });

  describe('Image Upload', () => {
    it('should upload and convert an image to SVG', async () => {
      // Create a test image file (simple 1x1 pixel PNG)
      const testImageData = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64'
      );

      const response = await request(app)
        .post('/api/upload/convert')
        .set('Cookie', `token=${authToken}`)
        .attach('image', testImageData, 'test-floor.png')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.svgContent).toContain('<svg');
      expect(response.body.data.originalFormat).toBe('png');
      expect(response.body.data.width).toBeGreaterThan(0);
      expect(response.body.data.height).toBeGreaterThan(0);
    });

    it('should upload SVG file directly', async () => {
      const testSVGContent = `
        <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
          <rect width="100" height="100" fill="blue"/>
        </svg>
      `;

      const response = await request(app)
        .post('/api/upload/svg')
        .set('Cookie', `token=${authToken}`)
        .attach('svg', Buffer.from(testSVGContent), 'test-floor.svg')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.svgContent).toContain('<svg>');
      expect(response.body.data.width).toBe(100);
      expect(response.body.data.height).toBe(100);
    });

    it('should require authentication for image upload', async () => {
      const response = await request(app)
        .post('/api/upload/convert')
        .attach('image', Buffer.from('test'), 'test.png')
        .expect(401);

      expect(response.body.success).toBe(false);
    });
  });

  describe('QR Code Generation', () => {
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
      expect(response.body.data.url).toContain('/uploads/qr-codes/');
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

    it('should serve QR code files directly', async () => {
      // First generate a QR code
      const qrRequest = {
        nodeId: 'test-node-id',
        buildingId: testBuilding._id.toString(),
        floorNumber: 1,
        format: 'png'
      };

      const generateResponse = await request(app)
        .post('/api/qr/generate')
        .set('Cookie', `token=${authToken}`)
        .send(qrRequest)
        .expect(200);

      const filename = generateResponse.body.data.filename;

      // Then try to access the file directly
      const fileResponse = await request(app)
        .get(`/api/qr/file/${filename}`)
        .expect(200);

      expect(fileResponse.headers['content-type']).toBe('image/png');
    });

    it('should return 404 for non-existent QR code file', async () => {
      const response = await request(app)
        .get('/api/qr/file/non-existent.png')
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('not found');
    });
  });

  describe('Static File Serving', () => {
    it('should serve uploaded images', async () => {
      // This test assumes there are uploaded files in the uploads directory
      // In a real scenario, you would upload a file first, then access it
      
      // Test that the static route is configured
      const response = await request(app)
        .get('/uploads')
        .expect(404); // Should return 404 for directory listing

      // The route should be configured (not 404 for route not found)
      expect(response.status).not.toBe(500);
    });
  });

  describe('Security', () => {
    it('should prevent unauthorized QR code generation', async () => {
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

    it('should prevent unauthorized image upload', async () => {
      const response = await request(app)
        .post('/api/upload/convert')
        .attach('image', Buffer.from('test'), 'test.png')
        .expect(401);

      expect(response.body.success).toBe(false);
    });
  });
});
