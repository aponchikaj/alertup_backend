import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../server.js';
import BUILDINGS from '../../src/models/building.model.js';
import Floor from '../../src/models/floor.model.js';
import USERS from '../../src/models/user.model.js';

describe('Floor Map Routes', () => {
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
    await BUILDINGS.deleteMany({});
    await Floor.deleteMany({});
    await USERS.deleteMany({});
    await mongoose.connection.close();
  });

  describe('GET /api/route/building/:buildingId/floor/:floorNumber', () => {
    it('should return 404 for non-existent floor', async () => {
      const response = await request(app)
        .get(`/api/route/building/${testBuilding._id}/floor/99`)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('Floor 99 not found');
    });

    it('should return 404 for floor without SVG content', async () => {
      const response = await request(app)
        .get(`/api/route/building/${testBuilding._id}/floor/1`)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('No SVG content available');
    });

    it('should return floor data when SVG content exists', async () => {
      // Create floor with SVG content
      const testFloor = new Floor({
        buildingId: testBuilding._id,
        floorNumber: 1,
        svgContent: '<svg><rect width="100" height="100"/></svg>',
        svgMapUrl: '/uploads/test.svg',
        width: 1000,
        height: 800
      });
      await testFloor.save();

      const response = await request(app)
        .get(`/api/route/building/${testBuilding._id}/floor/1`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.floor).toBe(1);
      expect(response.body.svgContent).toContain('<svg>');
      expect(response.body.svgDimensions.width).toBe(1000);
      expect(response.body.svgDimensions.height).toBe(800);
    });
  });

  describe('PUT /api/building/:buildingId/floor/:floorNumber/map', () => {
    it('should update floor map with SVG content', async () => {
      const svgData = {
        svgContent: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1000" height="800" fill="white"/></svg>',
        width: 1000,
        height: 800
      };

      const response = await request(app)
        .put(`/api/building/${testBuilding._id}/floor/2/map`)
        .set('Cookie', `token=${authToken}`)
        .send(svgData)
        .expect(200);

      expect(response.body.Success).toBe(true);
      expect(response.body.Message).toContain('updated successfully');

      // Verify floor was created
      const floor = await Floor.findOne({
        buildingId: testBuilding._id,
        floorNumber: 2
      });
      expect(floor).toBeTruthy();
      expect(floor.svgContent).toContain('<svg>');
      expect(floor.width).toBe(1000);
      expect(floor.height).toBe(800);
    });

    it('should require authentication', async () => {
      const svgData = {
        svgContent: '<svg><rect width="100" height="100"/></svg>',
        width: 1000,
        height: 800
      };

      const response = await request(app)
        .put(`/api/building/${testBuilding._id}/floor/2/map`)
        .send(svgData)
        .expect(401);

      expect(response.body.Success).toBe(false);
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

      const svgData = {
        svgContent: '<svg><rect width="100" height="100"/></svg>',
        width: 1000,
        height: 800
      };

      const response = await request(app)
        .put(`/api/building/${otherBuilding._id}/floor/1/map`)
        .set('Cookie', `token=${authToken}`)
        .send(svgData)
        .expect(404);

      expect(response.body.Success).toBe(false);
    });
  });
});
