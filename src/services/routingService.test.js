import { findShortestRoute, calculateDistance, findAllExits, validateRoute } from './routingService.js';
import Node from '../models/node.model.js';
import mongoose from 'mongoose';

const MONGODB_TEST_URL = process.env.MONGODB_TEST_URL || 'mongodb://localhost:27017/alertup-test';

beforeAll(async () => {
  try {
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
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
    }
  } catch (error) {
    console.error('Database disconnect error:', error);
  }
});

beforeEach(async () => {
  try {
    await Node.deleteMany({});
    await Building.deleteMany({});
  } catch (error) {
    console.error('Error clearing collections:', error);
  }
});

describe('findShortestRoute', () => {
  describe('Basic Functionality', () => {
    test('should find shortest path to exit from start node', async () => {
      // Setup
      const building = await Building.create({ name: 'Test Building' });

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

      // Update connections
      await Node.updateOne({ _id: startNode._id }, { connections: [exitNode._id] });

      // Execute
      const route = await findShortestRoute(startNode._id);

      // Assert
      expect(Array.isArray(route)).toBe(true);
      expect(route.length).toBeGreaterThanOrEqual(1);
      expect(route[route.length - 1].type).toBe('exit');
      expect(route[0].type).toBe('path');
      expect(route[0].x).toBe(100);
      expect(route[0].y).toBe(100);
    });

    test('should return immediate exit if start node is exit', async () => {
      // Setup
      const building = await Building.create({ name: 'Test Building' });

      const exitNode = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 100,
        y: 100,
        type: 'exit',
        connections: [],
      });

      // Execute
      const route = await findShortestRoute(exitNode._id);

      // Assert
      expect(route).toHaveLength(1);
      expect(route[0].type).toBe('exit');
      expect(route[0].x).toBe(100);
    });

    test('should find shortest path through multiple nodes', async () => {
      // Setup
      const building = await Building.create({ name: 'Test Building' });

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

      // Execute
      const route = await findShortestRoute(node1._id);

      // Assert
      expect(route.length).toBeGreaterThanOrEqual(2);
      expect(route[route.length - 1].type).toBe('exit');
    });

    test('should use stairs to reach exit', async () => {
      // Setup
      const building = await Building.create({ name: 'Test Building' });

      const startNode = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 100,
        y: 100,
        type: 'path',
        connections: [],
      });

      const stairsNode = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 300,
        y: 300,
        type: 'stairs',
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
      await Node.updateOne({ _id: startNode._id }, { connections: [stairsNode._id] });
      await Node.updateOne({ _id: stairsNode._id }, { connections: [exitNode._id] });

      // Execute
      const route = await findShortestRoute(startNode._id);

      // Assert
      expect(route.length).toBeGreaterThanOrEqual(2);
      expect(route.some((n) => n.type === 'stairs')).toBe(true);
      expect(route[route.length - 1].type).toBe('exit');
    });
  });

  describe('BFS Guarantees Shortest Path', () => {
    test('should return shortest of two paths', async () => {
      // Setup: Graph with two paths to exit
      const building = await Building.create({ name: 'Test Building' });

      const start = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 0,
        y: 0,
        type: 'path',
        connections: [],
      });

      // Short path: start -> exit
      const exit1 = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 100,
        y: 100,
        type: 'exit',
        connections: [],
      });

      // Long path: start -> node1 -> node2 -> node3 -> exit2
      const node1 = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 50,
        y: 50,
        type: 'path',
        connections: [],
      });

      const node2 = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 75,
        y: 75,
        type: 'path',
        connections: [],
      });

      const node3 = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 90,
        y: 90,
        type: 'path',
        connections: [],
      });

      const exit2 = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 200,
        y: 200,
        type: 'exit',
        connections: [],
      });

      // Create connections
      await Node.updateOne({ _id: start._id }, { connections: [exit1._id, node1._id] });
      await Node.updateOne({ _id: node1._id }, { connections: [node2._id] });
      await Node.updateOne({ _id: node2._id }, { connections: [node3._id] });
      await Node.updateOne({ _id: node3._id }, { connections: [exit2._id] });

      // Execute
      const route = await findShortestRoute(start._id);

      // Assert
      expect(route.length).toBeLessThanOrEqual(2); // Should take short path
      expect(route[route.length - 1].type).toBe('exit');
      expect(route[route.length - 1].x).toBe(100); // Should be exit1, not exit2
    });
  });

  describe('Error Handling', () => {
    test('should throw error for null node ID', async () => {
      await expect(findShortestRoute(null)).rejects.toThrow();
    });

    test('should throw error for undefined node ID', async () => {
      await expect(findShortestRoute(undefined)).rejects.toThrow();
    });

    test('should throw error for non-existent node', async () => {
      const fakeObjectId = new mongoose.Types.ObjectId();

      await expect(findShortestRoute(fakeObjectId)).rejects.toThrow(
        'Start node not found'
      );
    });

    test('should throw error when no exit exists on floor', async () => {
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

      // Execute & Assert
      await expect(findShortestRoute(node._id)).rejects.toThrow(
        'No exit route found'
      );
    });

    test('should throw error when exit is unreachable', async () => {
      // Setup
      const building = await Building.create({ name: 'Test Building' });

      const startNode = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 100,
        y: 100,
        type: 'path',
        connections: [],
      });

      // Create unreachable exit
      const exitNode = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 500,
        y: 500,
        type: 'exit',
        connections: [],
      });

      // No connections between nodes

      // Execute & Assert
      await expect(findShortestRoute(startNode._id)).rejects.toThrow(
        'No exit route found'
      );
    });

    test('should detect and prevent infinite loops', async () => {
      // Setup: Circular graph without exit
      const building = await Building.create({ name: 'Test Building' });

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
        x: 200,
        y: 200,
        type: 'path',
        connections: [],
      });

      const node3 = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 300,
        y: 300,
        type: 'path',
        connections: [],
      });

      // Create circular connections
      await Node.updateOne({ _id: node1._id }, { connections: [node2._id] });
      await Node.updateOne({ _id: node2._id }, { connections: [node3._id] });
      await Node.updateOne({ _id: node3._id }, { connections: [node1._id] });

      // Execute & Assert
      await expect(findShortestRoute(node1._id)).rejects.toThrow();
    });
  });

  describe('Data Validation', () => {
    test('should validate node coordinates in route', async () => {
      // Setup
      const building = await Building.create({ name: 'Test Building' });

      const startNode = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 123.45,
        y: 678.90,
        type: 'path',
        connections: [],
      });

      const exitNode = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 456.78,
        y: 912.34,
        type: 'exit',
        connections: [],
      });

      await Node.updateOne({ _id: startNode._id }, { connections: [exitNode._id] });

      // Execute
      const route = await findShortestRoute(startNode._id);

      // Assert
      route.forEach((node) => {
        expect(typeof node.x).toBe('number');
        expect(typeof node.y).toBe('number');
        expect(typeof node.type).toBe('string');
        expect(['path', 'exit', 'stairs']).toContain(node.type);
      });
    });

    test('should include node labels in route when available', async () => {
      // Setup
      const building = await Building.create({ name: 'Test Building' });

      const startNode = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 100,
        y: 100,
        type: 'path',
        label: 'Main Entrance',
        connections: [],
      });

      const exitNode = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        x: 500,
        y: 500,
        type: 'exit',
        label: 'Emergency Exit A',
        connections: [],
      });

      await Node.updateOne({ _id: startNode._id }, { connections: [exitNode._id] });

      // Execute
      const route = await findShortestRoute(startNode._id);

      // Assert
      expect(route[0].label).toBe('Main Entrance');
      expect(route[route.length - 1].label).toBe('Emergency Exit A');
    });
  });
});

describe('calculateDistance', () => {
  test('should calculate distance between two points', () => {
    // Points (0,0) and (3,4) should have distance 5
    const distance = calculateDistance(0, 0, 3, 4);

    expect(distance).toBe(5);
  });

  test('should calculate distance with same points', () => {
    const distance = calculateDistance(100, 100, 100, 100);

    expect(distance).toBe(0);
  });

  test('should work with negative coordinates', () => {
    const distance = calculateDistance(-10, -10, 0, 0);

    expect(distance).toBeCloseTo(Math.sqrt(200), 5);
  });

  test('should work with decimal coordinates', () => {
    const distance = calculateDistance(0, 0, 1.5, 2);

    expect(distance).toBeCloseTo(2.5, 5);
  });
});
