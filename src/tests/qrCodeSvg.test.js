import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../server.js';
import BUILDINGS from '../../src/models/building.model.js';
import USERS from '../../src/models/user.model.js';
import Node from '../../src/models/node.model.js';
import fs from 'fs';
import path from 'path';

describe('QR Code SVG Generation', () => {
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
    
    // Clean up QR code files
    const qrDir = path.join(process.cwd(), 'uploads', 'qr-codes');
    if (fs.existsSync(qrDir)) {
      const files = fs.readdirSync(qrDir);
      files.forEach(file => {
        if (file.includes('test-qr') || file.includes('qr-')) {
          fs.unlinkSync(path.join(qrDir, file));
        }
      });
    }
    
    await mongoose.connection.close();
  });

  describe('QR Code SVG Generation', () => {
    it('should generate QR code in SVG format', async () => {
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
      expect(response.body.data.format).toBe('svg');
      expect(response.body.data.filename).toBeTruthy();
      expect(response.body.data.filename).endsWith('.svg');
      expect(response.body.data.svgContent).toContain('<svg');
      expect(response.body.data.url).toContain('/uploads/qr-codes/');
      expect(response.body.data.qrData).toContain('http://localhost:5173');
    });

    it('should create actual SVG file on disk', async () => {
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

      const filename = response.body.data.filename;
      const filePath = path.join(process.cwd(), 'uploads', 'qr-codes', filename);
      
      // Check if file exists
      expect(fs.existsSync(filePath)).toBe(true);
      
      // Check file content
      const fileContent = fs.readFileSync(filePath, 'utf8');
      expect(fileContent).toContain('<svg');
      expect(fileContent).toContain('http://localhost:5173');
    });

    it('should generate QR code with correct frontend URL', async () => {
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

      const expectedUrl = `http://localhost:5173/route/qr_${testBuilding._id}_1_${testNode._id}`;
      expect(response.body.data.qrData).toBe(expectedUrl);
      expect(response.body.data.svgContent).toContain(expectedUrl);
    });

    it('should serve SVG files with correct headers', async () => {
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

      expect(fileResponse.headers['content-type']).toBe('image/svg+xml');
      expect(fileResponse.text).toContain('<svg');
    });

    it('should generate unique filenames for each QR code', async () => {
      // Generate first QR code
      const response1 = await request(app)
        .post('/api/qr/generate')
        .set('Cookie', `token=${authToken}`)
        .send({
          nodeId: testNode._id.toString(),
          buildingId: testBuilding._id.toString(),
          floorNumber: 1,
          format: 'svg'
        })
        .expect(200);

      // Generate second QR code
      const response2 = await request(app)
        .post('/api/qr/generate')
        .set('Cookie', `token=${authToken}`)
        .send({
          nodeId: testNode._id.toString(),
          buildingId: testBuilding._id.toString(),
          floorNumber: 1,
          format: 'svg'
        })
        .expect(200);

      expect(response1.body.data.filename).not.toBe(response2.body.data.filename);
      expect(response1.body.data.filename).endsWith('.svg');
      expect(response2.body.data.filename).endsWith('.svg');
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/qr/generate')
        .send({
          nodeId: testNode._id.toString(),
          buildingId: testBuilding._id.toString(),
          floorNumber: 1,
          format: 'svg'
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

      // Try to generate QR code with original user
      const response = await request(app)
        .post('/api/qr/generate')
        .set('Cookie', `token=${authToken}`)
        .send({
          nodeId: otherNode._id.toString(),
          buildingId: otherBuilding._id.toString(),
          floorNumber: 1,
          format: 'svg'
        })
        .expect(404);

      expect(response.body.success).toBe(false);
    });

    it('should validate required fields', async () => {
      const response = await request(app)
        .post('/api/qr/generate')
        .set('Cookie', `token=${authToken}`)
        .send({
          // Missing nodeId, buildingId, floorNumber
          format: 'svg'
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('Missing required fields');
    });

    it('should validate format', async () => {
      const response = await request(app)
        .post('/api/qr/generate')
        .set('Cookie', `token=${authToken}`)
        .send({
          nodeId: testNode._id.toString(),
          buildingId: testBuilding._id.toString(),
          floorNumber: 1,
          format: 'invalid'
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('Invalid format');
    });
  });

  describe('QR Code PNG Generation', () => {
    it('should generate QR code in PNG format', async () => {
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
      expect(response.body.data.format).toBe('png');
      expect(response.body.data.filename).toBeTruthy();
      expect(response.body.data.filename).endsWith('.png');
      expect(response.body.data.url).toContain('/uploads/qr-codes/');
      expect(response.body.data.qrData).toContain('http://localhost:5173');
    });

    it('should create actual PNG file on disk', async () => {
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

      const filename = response.body.data.filename;
      const filePath = path.join(process.cwd(), 'uploads', 'qr-codes', filename);
      
      // Check if file exists
      expect(fs.existsSync(filePath)).toBe(true);
      
      // Check if it's a valid PNG file (starts with PNG signature)
      const fileBuffer = fs.readFileSync(filePath);
      expect(fileBuffer[0]).toBe(0x89); // PNG signature first byte
      expect(fileBuffer[1]).toBe(0x50); // 'P'
      expect(fileBuffer[2]).toBe(0x4E); // 'N'
      expect(fileBuffer[3]).toBe(0x47); // 'G'
    });
  });

  describe('QR Code File Serving', () => {
    it('should serve SVG QR code files directly', async () => {
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

      // Access via file serving route
      const fileResponse = await request(app)
        .get(`/api/qr/file/${filename}`)
        .expect(200);

      expect(fileResponse.headers['content-type']).toBe('image/svg+xml');
      expect(fileResponse.text).toContain('<svg');
    });

    it('should serve PNG QR code files directly', async () => {
      // Generate QR code first
      const generateResponse = await request(app)
        .post('/api/qr/generate')
        .set('Cookie', `token=${authToken}`)
        .send({
          nodeId: testNode._id.toString(),
          buildingId: testBuilding._id.toString(),
          floorNumber: 1,
          format: 'png'
        })
        .expect(200);

      const filename = generateResponse.body.data.filename;

      // Access via file serving route
      const fileResponse = await request(app)
        .get(`/api/qr/file/${filename}`)
        .expect(200);

      expect(fileResponse.headers['content-type']).toBe('image/png');
    });

    it('should return 404 for non-existent QR code files', async () => {
      const response = await request(app)
        .get('/api/qr/file/non-existent.svg')
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('not found');
    });
  });
});
