import request from 'supertest';
import express from 'express';
import mongoose from 'mongoose';
import routeRouter from './route.js';
import QRCode from '../../models/qrcode.model.js';
import Node from '../../models/node.model.js';
import Floor from '../../models/floor.model.js';
import Building from '../../models/building.model.js';

// Create a test Express app
const app = express();
app.use(express.json());
app.use('/api/route', routeRouter);

// Test database setup
const MONGODB_TEST_URL = process.env.MONGODB_TEST_URL || 'mongodb://localhost:27017/alertup-test';

beforeAll(async () => {
  try {
    // Connect to test database
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(MONGODB_TEST_URL);
    }
  } catch (error) {
    console.error('Database connection error:', error);
    throw error;
  }
});

afterAll(async () => {
  try {
    // Clean up and disconnect
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
    }
  } catch (error) {
    console.error('Database disconnect error:', error);
  }
});

beforeEach(async () => {
  // Clear collections before each test
  try {
    await Promise.all([
      QRCode.deleteMany({}),
      Node.deleteMany({}),
      Floor.deleteMany({}),
      Building.deleteMany({}),
    ]);
  } catch (error) {
    console.error('Error clearing collections:', error);
  }
});

describe('Emergency Routing API - /api/route/:qrId', () => {
  describe('Valid QR Code Requests', () => {
    test('should return route for valid QR code', async () => {
      // Setup: Create test data
      const building = await Building.create({ name: 'Test Building' });
      const floor = await Floor.create({
        buildingId: building._id,
        floorNumber: 1,
        svgMapUrl: 'https://example.com/floor1.svg',
        width: 1000,
        height: 800,
      });

      const startNode = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 100,
        y: 100,
        type: 'path',
        connections: [],
      });

      const exitNode = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 500,
        y: 500,
        type: 'exit',
        connections: [],
      });

      // Update start node connections
      await Node.updateOne({ _id: startNode._id }, { connections: [exitNode._id] });

      const qrCode = await QRCode.create({
        code: 'TEST_QR_001',
        buildingId: building._id,
        floorNumber: 1,
        nodeId: startNode._id,
        isActive: true,
      });

      // Execute: Make request
      const response = await request(app).get('/api/route/TEST_QR_001');

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.floor).toBe(1);
      expect(response.body.building).toBe('Test Building');
      expect(Array.isArray(response.body.route)).toBe(true);
      expect(response.body.route.length).toBeGreaterThan(0);
      expect(response.body.startPoint.x).toBe(100);
      expect(response.body.startPoint.y).toBe(100);
      expect(response.body.svgDimensions.width).toBe(1000);
      expect(response.body.svgDimensions.height).toBe(800);
    });

    test('should handle start node that is already an exit', async () => {
      // Setup
      const building = await Building.create({ name: 'Test Building' });
      const floor = await Floor.create({
        buildingId: building._id,
        floorNumber: 1,
        svgMapUrl: 'https://example.com/floor1.svg',
        width: 1000,
        height: 800,
      });

      const exitNode = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 100,
        y: 100,
        type: 'exit',
        connections: [],
      });

      const qrCode = await QRCode.create({
        code: 'TEST_QR_EXIT',
        buildingId: building._id,
        floorNumber: 1,
        nodeId: exitNode._id,
        isActive: true,
      });

      // Execute
      const response = await request(app).get('/api/route/TEST_QR_EXIT');

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.route).toHaveLength(1);
      expect(response.body.route[0].type).toBe('exit');
    });

    test('should find route through multiple nodes', async () => {
      // Setup
      const building = await Building.create({ name: 'Test Building' });
      const floor = await Floor.create({
        buildingId: building._id,
        floorNumber: 1,
        svgMapUrl: 'https://example.com/floor1.svg',
        width: 1000,
        height: 800,
      });

      const node1 = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 100,
        y: 100,
        type: 'path',
        connections: [],
      });

      const node2 = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 300,
        y: 300,
        type: 'path',
        connections: [],
      });

      const exitNode = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 500,
        y: 500,
        type: 'exit',
        connections: [],
      });

      // Create connections
      await Node.updateOne({ _id: node1._id }, { connections: [node2._id] });
      await Node.updateOne({ _id: node2._id }, { connections: [exitNode._id] });

      const qrCode = await QRCode.create({
        code: 'TEST_QR_MULTI',
        buildingId: building._id,
        floorNumber: 1,
        nodeId: node1._id,
        isActive: true,
      });

      // Execute
      const response = await request(app).get('/api/route/TEST_QR_MULTI');

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.route.length).toBeGreaterThanOrEqual(2);
      // Last node should be exit
      expect(response.body.route[response.body.route.length - 1].type).toBe('exit');
    });
  });

  describe('Invalid QR Code Requests', () => {
    test('should return 404 for non-existent QR code', async () => {
      const response = await request(app).get('/api/route/NONEXISTENT_QR');

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('not found');
    });

    test('should return 404 for inactive QR code', async () => {
      // Setup
      const building = await Building.create({ name: 'Test Building' });
      const node = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 100,
        y: 100,
        type: 'path',
        connections: [],
      });

      const qrCode = await QRCode.create({
        code: 'TEST_QR_INACTIVE',
        buildingId: building._id,
        floorNumber: 1,
        nodeId: node._id,
        isActive: false,
      });

      // Execute
      const response = await request(app).get('/api/route/TEST_QR_INACTIVE');

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
    });

    test('should return 400 for invalid QR code format', async () => {
      const response = await request(app).get('/api/route/');

      expect([404, 400]).toContain(response.status);
    });

    test('should return 400 for excessively long QR code', async () => {
      const longQR = 'A'.repeat(600);
      const response = await request(app).get(`/api/route/${longQR}`);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });

  describe('Route Not Found Scenarios', () => {
    test('should return error when no exit exists on floor', async () => {
      // Setup
      const building = await Building.create({ name: 'Test Building' });
      const floor = await Floor.create({
        buildingId: building._id,
        floorNumber: 1,
        svgMapUrl: 'https://example.com/floor1.svg',
        width: 1000,
        height: 800,
      });

      const node = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 100,
        y: 100,
        type: 'path',
        connections: [],
      });

      const qrCode = await QRCode.create({
        code: 'TEST_QR_NO_EXIT',
        buildingId: building._id,
        floorNumber: 1,
        nodeId: node._id,
        isActive: true,
      });

      // Execute
      const response = await request(app).get('/api/route/TEST_QR_NO_EXIT');

      // Assert
      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('No exit');
    });

    test('should return error when exit is disconnected from start', async () => {
      // Setup
      const building = await Building.create({ name: 'Test Building' });
      const floor = await Floor.create({
        buildingId: building._id,
        floorNumber: 1,
        svgMapUrl: 'https://example.com/floor1.svg',
        width: 1000,
        height: 800,
      });

      const startNode = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 100,
        y: 100,
        type: 'path',
        connections: [],
      });

      // Create disconnected exit
      const exitNode = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 500,
        y: 500,
        type: 'exit',
        connections: [],
      });

      const qrCode = await QRCode.create({
        code: 'TEST_QR_DISCONNECTED',
        buildingId: building._id,
        floorNumber: 1,
        nodeId: startNode._id,
        isActive: true,
      });

      // Execute
      const response = await request(app).get('/api/route/TEST_QR_DISCONNECTED');

      // Assert
      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });

  describe('Data Validation', () => {
    test('should validate SVG dimensions in response', async () => {
      // Setup
      const building = await Building.create({ name: 'Test Building' });
      const floor = await Floor.create({
        buildingId: building._id,
        floorNumber: 1,
        svgMapUrl: 'https://example.com/floor1.svg',
        width: 1000,
        height: 800,
      });

      const exitNode = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 100,
        y: 100,
        type: 'exit',
        connections: [],
      });

      const qrCode = await QRCode.create({
        code: 'TEST_QR_DIMS',
        buildingId: building._id,
        floorNumber: 1,
        nodeId: exitNode._id,
        isActive: true,
      });

      // Execute
      const response = await request(app).get('/api/route/TEST_QR_DIMS');

      // Assert
      expect(response.body.svgDimensions.width).toBe(1000);
      expect(response.body.svgDimensions.height).toBe(800);
      expect(response.body.svgDimensions.width).toBeGreaterThan(0);
      expect(response.body.svgDimensions.height).toBeGreaterThan(0);
    });

    test('should use default dimensions when floor missing', async () => {
      // Setup - create QR with no matching floor
      const building = await Building.create({ name: 'Test Building' });
      const exitNode = await Node.create({
        buildingId: building._id,
        floorNumber: 2,
        x: 100,
        y: 100,
        type: 'exit',
        connections: [],
      });

      const qrCode = await QRCode.create({
        code: 'TEST_QR_NO_FLOOR',
        buildingId: building._id,
        floorNumber: 2,
        nodeId: exitNode._id,
        isActive: true,
      });

      // Execute
      const response = await request(app).get('/api/route/TEST_QR_NO_FLOOR');

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.svgDimensions.width).toBe(1000); // Default
      expect(response.body.svgDimensions.height).toBe(800); // Default
    });

    test('should validate route node coordinates', async () => {
      // Setup
      const building = await Building.create({ name: 'Test Building' });
      const floor = await Floor.create({
        buildingId: building._id,
        floorNumber: 1,
        svgMapUrl: 'https://example.com/floor1.svg',
        width: 1000,
        height: 800,
      });

      const node = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 100,
        y: 200,
        type: 'exit',
        connections: [],
      });

      const qrCode = await QRCode.create({
        code: 'TEST_QR_COORDS',
        buildingId: building._id,
        floorNumber: 1,
        nodeId: node._id,
        isActive: true,
      });

      // Execute
      const response = await request(app).get('/api/route/TEST_QR_COORDS');

      // Assert
      expect(response.body.route[0].x).toBe(100);
      expect(response.body.route[0].y).toBe(200);
      expect(typeof response.body.route[0].type).toBe('string');
    });
  });
});

describe('Emergency Routing API - /api/route/building/:id/floor/:num', () => {
  describe('Valid Floor Requests', () => {
    test('should return floor data for valid building and floor', async () => {
      // Setup
      const building = await Building.create({ name: 'Test Building' });
      const floor = await Floor.create({
        buildingId: building._id,
        floorNumber: 1,
        svgMapUrl: 'https://example.com/floor1.svg',
        svgContent: '<svg></svg>',
        width: 1000,
        height: 800,
      });

      // Execute
      const response = await request(app).get(
        `/api/route/building/${building._id}/floor/1`
      );

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.floor).toBe(1);
      expect(response.body.svgMapUrl).toBe('https://example.com/floor1.svg');
      expect(response.body.svgDimensions.width).toBe(1000);
    });
  });

  describe('Invalid Floor Requests', () => {
    test('should return 404 for non-existent floor', async () => {
      // Setup
      const building = await Building.create({ name: 'Test Building' });

      // Execute
      const response = await request(app).get(
        `/api/route/building/${building._id}/floor/99`
      );

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
    });

    test('should return 400 for invalid building ID', async () => {
      const response = await request(app).get(
        '/api/route/building/invalid-id/floor/1'
      );

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    test('should return 400 for invalid floor number', async () => {
      const building = await Building.create({ name: 'Test Building' });

      const response = await request(app).get(
        `/api/route/building/${building._id}/floor/abc`
      );

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    test('should return 400 for negative floor number', async () => {
      const building = await Building.create({ name: 'Test Building' });

      const response = await request(app).get(
        `/api/route/building/${building._id}/floor/-1`
      );

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });
});

describe('Error Handling', () => {
  test('should handle database errors gracefully', async () => {
    // Test with invalid ObjectId that is formatted correctly
    const fakeObjectId = '000000000000000000000000';

    const response = await request(app).get(
      `/api/route/building/${fakeObjectId}/floor/1`
    );

    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
  });

  test('should not expose sensitive error details', async () => {
    const response = await request(app).get('/api/route/TEST_NONEXISTENT');

    expect(response.body.message).toBeDefined();
    expect(response.body.message).not.toContain('MongoDB');
    expect(response.body.message).not.toContain('Stack');
  });
});
