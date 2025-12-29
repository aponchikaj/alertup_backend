/**
 * Database Migration Scripts for Emergency Routing System
 * Run these scripts to initialize and populate the database
 */

import mongoose from 'mongoose';
import Building from '../models/building.model.js';
import Floor from '../models/floor.model.js';
import Node from '../models/node.model.js';
import QRCode from '../models/qrcode.model.js';

/**
 * MIGRATION 1: Create indexes for all routing-related collections
 * Run this once after creating models
 */
export const createIndexes = async () => {
  console.log('Creating indexes...');

  try {
    // Node indexes
    await Node.collection.createIndex({ buildingId: 1, floorNumber: 1 });
    await Node.collection.createIndex({ buildingId: 1, floorNumber: 1, type: 1 });
    console.log('✓ Node indexes created');

    // Floor indexes
    await Floor.collection.createIndex(
      { buildingId: 1, floorNumber: 1 },
      { unique: true }
    );
    console.log('✓ Floor indexes created');

    // QRCode indexes
    await QRCode.collection.createIndex({ code: 1 }, { unique: true });
    await QRCode.collection.createIndex({ code: 1, isActive: 1 });
    console.log('✓ QRCode indexes created');

    console.log('All indexes created successfully');
  } catch (error) {
    console.error('Error creating indexes:', error);
    throw error;
  }
};

/**
 * MIGRATION 2: Seed example data for testing
 * Run this to populate database with sample building/floor/nodes
 */
export const seedExampleData = async () => {
  console.log('Seeding example data...');

  try {
    // Create building
    const building = await Building.create({
      name: 'Emergency Test Building',
      address: '123 Safety Street',
    });
    console.log('✓ Building created:', building._id);

    // Create floor
    const floor = await Floor.create({
      buildingId: building._id,
      floorNumber: 1,
      svgMapUrl: 'https://example.com/floor1.svg',
      width: 1000,
      height: 800,
      svgContent: `
        <rect x="0" y="0" width="1000" height="800" fill="#f5f5f5" stroke="#ccc" stroke-width="2"/>
        <text x="50" y="50" font-size="20" font-weight="bold">Floor 1 - Emergency Exit Map</text>
        <rect x="100" y="100" width="200" height="150" fill="#e8f5e9" stroke="#4caf50" stroke-width="2"/>
        <text x="150" y="160" font-size="12">Office A</text>
        <rect x="400" y="100" width="200" height="150" fill="#e8f5e9" stroke="#4caf50" stroke-width="2"/>
        <text x="450" y="160" font-size="12">Office B</text>
        <rect x="700" y="100" width="200" height="150" fill="#e8f5e9" stroke="#4caf50" stroke-width="2"/>
        <text x="750" y="160" font-size="12">Office C</text>
      `,
    });
    console.log('✓ Floor created:', floor._id);

    // Create nodes
    const nodeData = [
      { label: 'Entrance A', x: 100, y: 100, type: 'path' },
      { label: 'Corridor A', x: 200, y: 200, type: 'path' },
      { label: 'Corridor B', x: 400, y: 250, type: 'path' },
      { label: 'Stairs 1', x: 500, y: 300, type: 'stairs' },
      { label: 'Emergency Exit 1', x: 600, y: 400, type: 'exit' },
      { label: 'Corridor C', x: 700, y: 250, type: 'path' },
      { label: 'Emergency Exit 2', x: 800, y: 300, type: 'exit' },
      { label: 'Emergency Exit 3', x: 900, y: 150, type: 'exit' },
    ];

    const nodes = [];
    for (const data of nodeData) {
      const node = await Node.create({
        buildingId: building._id,
        floorNumber: 1,
        ...data,
        connections: [],
      });
      nodes.push(node);
    }
    console.log('✓ Nodes created:', nodes.length);

    // Create connections between nodes
    const connections = [
      [0, 1], // Entrance A -> Corridor A
      [1, 2], // Corridor A -> Corridor B
      [2, 3], // Corridor B -> Stairs
      [2, 5], // Corridor B -> Corridor C
      [3, 4], // Stairs -> Exit 1
      [5, 6], // Corridor C -> Exit 2
      [0, 7], // Entrance A -> Exit 3
    ];

    for (const [from, to] of connections) {
      nodes[from].connections.push(nodes[to]._id);
    }

    // Save all nodes with updated connections
    for (const node of nodes) {
      await node.save();
    }
    console.log('✓ Node connections created');

    // Create QR codes
    const qrCodes = [
      {
        code: 'QR_DEMO_001',
        nodeId: nodes[0]._id, // Entrance A
      },
      {
        code: 'QR_DEMO_002',
        nodeId: nodes[1]._id, // Corridor A
      },
      {
        code: 'QR_DEMO_003',
        nodeId: nodes[2]._id, // Corridor B
      },
    ];

    for (const qrData of qrCodes) {
      await QRCode.create({
        ...qrData,
        buildingId: building._id,
        floorNumber: 1,
        isActive: true,
      });
    }
    console.log('✓ QR codes created:', qrCodes.length);

    console.log('\n✓ Example data seeded successfully!');
    console.log('\nTest with these QR codes:');
    qrCodes.forEach(qr => {
      console.log(`  - ${qr.code}`);
    });

    return { building, floor, nodes };
  } catch (error) {
    console.error('Error seeding data:', error);
    throw error;
  }
};

/**
 * MIGRATION 3: Clear all routing data
 * Use with caution - removes all buildings, floors, nodes, QR codes
 */
export const clearAllData = async () => {
  console.log('Clearing all routing data...');

  try {
    await QRCode.deleteMany({});
    await Node.deleteMany({});
    await Floor.deleteMany({});
    await Building.deleteMany({});

    console.log('✓ All routing data cleared');
  } catch (error) {
    console.error('Error clearing data:', error);
    throw error;
  }
};

/**
 * MIGRATION 4: Validate database integrity
 * Checks for orphaned records and inconsistencies
 */
export const validateDatabase = async () => {
  console.log('Validating database integrity...');

  const issues = [];

  try {
    // Check for QR codes with missing buildings
    const qrCodes = await QRCode.find();
    for (const qr of qrCodes) {
      const building = await Building.findById(qr.buildingId);
      if (!building) {
        issues.push(`QR code ${qr.code} references non-existent building`);
      }
    }

    // Check for nodes with missing buildings
    const nodes = await Node.find();
    for (const node of nodes) {
      const building = await Building.findById(node.buildingId);
      if (!building) {
        issues.push(`Node ${node._id} references non-existent building`);
      }
    }

    // Check for orphaned connections
    for (const node of nodes) {
      for (const connId of node.connections) {
        const connNode = await Node.findById(connId);
        if (!connNode) {
          issues.push(
            `Node ${node._id} has broken connection to ${connId}`
          );
        }
      }
    }

    if (issues.length === 0) {
      console.log('✓ Database is valid');
    } else {
      console.log('✗ Found issues:');
      issues.forEach(issue => console.log(`  - ${issue}`));
    }

    return { isValid: issues.length === 0, issues };
  } catch (error) {
    console.error('Error validating database:', error);
    throw error;
  }
};

/**
 * MIGRATION 5: Repair broken connections
 * Attempts to fix orphaned node references
 */
export const repairConnections = async () => {
  console.log('Repairing broken connections...');

  try {
    const nodes = await Node.find();
    let repaired = 0;

    for (const node of nodes) {
      const validConnections = [];

      for (const connId of node.connections) {
        const connNode = await Node.findById(connId);
        if (connNode) {
          validConnections.push(connId);
        } else {
          console.log(`  Removed broken connection: ${connId}`);
          repaired++;
        }
      }

      if (validConnections.length !== node.connections.length) {
        node.connections = validConnections;
        await node.save();
      }
    }

    console.log(`✓ Repaired ${repaired} broken connections`);
  } catch (error) {
    console.error('Error repairing connections:', error);
    throw error;
  }
};

/**
 * Main migration runner
 * Call this from your database initialization script
 */
export const runMigrations = async () => {
  try {
    console.log('Starting migrations...\n');

    await createIndexes();
    await seedExampleData();
    await validateDatabase();

    console.log('\n✓ All migrations completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
};

// Usage:
// import { runMigrations } from './migrations/routing.migrations.js';
// await runMigrations();
