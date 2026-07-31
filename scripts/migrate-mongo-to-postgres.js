#!/usr/bin/env node
/**
 * One-shot Mongo → Postgres ETL.
 *
 *   node scripts/migrate-mongo-to-postgres.js [--dry-run] [--wipe]
 *
 * Reads via the raw mongodb driver (MONGO_STRING), writes via Prisma
 * (DATABASE_URL). Mongo is never written to — it remains the rollback state.
 *
 * Invariants this script guarantees:
 *  - every migrated row keeps its Mongo ObjectId hex string as its Postgres id
 *    (printed QR codes embed those ids)
 *  - every building gets the seeded system roles
 *  - floors merge the two legacy representations (buildings.maps[] and the
 *    Floor collection) into one row per (buildingId, floorNumber)
 *  - edges are derived symmetric-once from node.connections[], with every
 *    dangling or asymmetric reference logged
 *
 * --dry-run: read + transform + report, no writes.
 * --wipe:    truncate all Postgres tables first (idempotent reruns).
 */

import { MongoClient, ObjectId } from 'mongodb';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { SYSTEM_ROLES } from '../src/auth/permissions.js';
import { buildQrSlug } from '../src/features/qr/qrPayload.js';

dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');
const WIPE = process.argv.includes('--wipe');

const MONGO_STRING = process.env.MONGO_STRING;
if (!MONGO_STRING) {
  console.error('MONGO_STRING is not set.');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const prisma = new PrismaClient();
const mongo = new MongoClient(MONGO_STRING);

const warnings = [];
const warn = (msg) => {
  warnings.push(msg);
  console.warn(`  ⚠ ${msg}`);
};

const hex = (v) => (v instanceof ObjectId ? v.toHexString() : v ? String(v) : null);

const NODE_TYPE_MAP = { path: 'NORMAL', exit: 'EMERGENCY_EXIT', stairs: 'TRANSIT' };
const USER_TYPE_MAP = { individual: 'INDIVIDUAL', company: 'COMPANY' };
const TRIGGER_MAP = { admin: 'ADMIN', system: 'SYSTEM', manual: 'MANUAL', sensor: 'SENSOR' };
const LOG_TYPE_MAP = {
  system: 'SYSTEM',
  report: 'REPORT',
  error: 'ERROR',
  scan: 'SCAN',
  evacuated: 'EVACUATED',
  emergency: 'EMERGENCY',
};

const toDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

async function wipe() {
  const tables = await prisma.$queryRawUnsafe(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`
  );
  const names = tables.map((t) => `"${t.tablename}"`).join(', ');
  if (names) {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
  }
  console.log('Postgres tables truncated.');
}

async function run() {
  await mongo.connect();
  const db = mongo.db();
  console.log(`Connected to Mongo (${db.databaseName}). Dry run: ${DRY_RUN}`);

  if (WIPE && !DRY_RUN) await wipe();

  const stats = {};

  // ------------------------------------------------------------- users ----
  const users = await db.collection('users').find({}).toArray();
  const userIds = new Set(users.map((u) => hex(u._id)));
  console.log(`users: ${users.length}`);
  if (!DRY_RUN) {
    for (const u of users) {
      await prisma.user.create({
        data: {
          id: hex(u._id),
          email: String(u.email || `missing-${hex(u._id)}@invalid.local`).toLowerCase(),
          password: u.password || null,
          name: u.name || '',
          lastname: u.lastname || '',
          company: u.company || '',
          tokenVersion: u.tokenVersion || 0,
          country: u.country || null,
          countryCode: u.countryCode || null,
          phone: u.phones || null,
          verified: Boolean(u.verified),
          userType: USER_TYPE_MAP[String(u.userType || '').toLowerCase()] || null,
          twoFactorEnabled: Boolean(u.TwoFactorEnabled),
          trustedIps: Array.isArray(u.trustedIPS) ? u.trustedIPS.filter(Boolean) : [],
          createdAt: toDate(u.createdAt) || new Date(),
          updatedAt: toDate(u.updatedAt) || new Date(),
        },
      });
    }
  }
  stats.users = users.length;

  // --------------------------------------------------------- buildings ----
  const buildings = await db.collection('buildings').find({}).toArray();
  console.log(`buildings: ${buildings.length}`);
  const migratedBuildings = new Set();
  const rolesByBuilding = new Map(); // buildingId -> {name -> roleId}

  for (const b of buildings) {
    const id = hex(b._id);
    const ownerId = hex(b.owner);
    if (!ownerId || !userIds.has(ownerId)) {
      warn(`building ${id} ("${b.buildingName}") has missing/dangling owner ${ownerId} — SKIPPED (decide manually)`);
      continue;
    }
    migratedBuildings.add(id);
    if (!DRY_RUN) {
      await prisma.building.create({
        data: {
          id,
          name: b.buildingName || 'Unnamed building',
          ownerId,
          isDeactivated: Boolean(b.isDeactivated),
          emergencyMode: Boolean(b.emergencyMode),
          createdAt: toDate(b.createdAt) || new Date(),
          updatedAt: toDate(b.updatedAt) || new Date(),
        },
      });
      const roleMap = {};
      for (const spec of SYSTEM_ROLES) {
        const role = await prisma.role.create({
          data: {
            buildingId: id,
            name: spec.name,
            permissions: [...spec.permissions],
            isSystem: true,
          },
        });
        roleMap[spec.name] = role.id;
      }
      rolesByBuilding.set(id, roleMap);
    }
  }
  stats.buildings = migratedBuildings.size;

  // ------------------------------------------------------------ floors ----
  // Source 1: buildings.maps[] — floor label strings + Cloudinary map URLs.
  // Source 2: the Floor collection — numeric floorNumber + SVG content.
  // Merge on (buildingId, floorNumber).
  const floorRows = new Map(); // `${buildingId}:${floorNumber}` -> row
  const floorIdByKey = new Map();

  for (const b of buildings) {
    const buildingId = hex(b._id);
    if (!migratedBuildings.has(buildingId)) continue;
    const maps = Array.isArray(b.maps) ? b.maps : [];
    maps.forEach((m, i) => {
      let floorNumber = parseInt(m.floor, 10);
      if (!Number.isInteger(floorNumber) || floorNumber < 0) {
        floorNumber = i + 1;
        warn(`building ${buildingId} maps[${i}] floor label "${m.floor}" is non-numeric — assigned floorNumber ${floorNumber}`);
      }
      const key = `${buildingId}:${floorNumber}`;
      if (floorRows.has(key)) {
        warn(`building ${buildingId} has duplicate floorNumber ${floorNumber} in maps[] — keeping first`);
        return;
      }
      floorRows.set(key, {
        buildingId,
        floorNumber,
        name: m.floor != null ? String(m.floor) : `Floor ${floorNumber}`,
        mapImageUrl: m.map || null,
        qrCodeUrl: m.qrCode || null,
        scanCount: m.scanned || 0,
        svgContent: null,
        width: null,
        height: null,
        createdAt: toDate(m.createdAt) || new Date(),
      });
    });
  }

  const floorDocs = await db.collection('floors').find({}).toArray();
  for (const f of floorDocs) {
    const buildingId = hex(f.buildingId);
    if (!migratedBuildings.has(buildingId)) {
      warn(`floor doc ${hex(f._id)} references unmigrated building ${buildingId} — skipped`);
      continue;
    }
    const key = `${buildingId}:${f.floorNumber}`;
    const existing = floorRows.get(key);
    if (existing) {
      existing.svgContent = f.svgContent || existing.svgContent;
      existing.width = f.width || existing.width;
      existing.height = f.height || existing.height;
      if (!existing.mapImageUrl && f.svgMapUrl && String(f.svgMapUrl).startsWith('http')) {
        existing.mapImageUrl = f.svgMapUrl;
      }
    } else {
      floorRows.set(key, {
        buildingId,
        floorNumber: f.floorNumber,
        name: `Floor ${f.floorNumber}`,
        mapImageUrl: String(f.svgMapUrl || '').startsWith('http') ? f.svgMapUrl : null,
        qrCodeUrl: null,
        scanCount: 0,
        svgContent: f.svgContent || null,
        width: f.width || null,
        height: f.height || null,
        createdAt: toDate(f.createdAt) || new Date(),
      });
    }
  }

  // Source 3: nodes on floors with no record at all → placeholder rows.
  const nodes = await db.collection('nodes').find({}).toArray();
  for (const n of nodes) {
    const buildingId = hex(n.buildingId);
    if (!migratedBuildings.has(buildingId)) continue;
    const key = `${buildingId}:${n.floorNumber}`;
    if (!floorRows.has(key)) {
      warn(`building ${buildingId} floor ${n.floorNumber} exists only via nodes — placeholder floor created`);
      floorRows.set(key, {
        buildingId,
        floorNumber: n.floorNumber,
        name: `Floor ${n.floorNumber}`,
        mapImageUrl: null,
        qrCodeUrl: null,
        scanCount: 0,
        svgContent: null,
        width: null,
        height: null,
        createdAt: new Date(),
      });
    }
  }

  console.log(`floors (merged): ${floorRows.size}`);
  if (!DRY_RUN) {
    for (const [key, row] of floorRows) {
      const created = await prisma.floor.create({ data: row });
      floorIdByKey.set(key, created.id);
    }
  }
  stats.floors = floorRows.size;

  // ------------------------------------------------------------- nodes ----
  const migratedNodes = new Map(); // id -> {buildingId, floorNumber, x, y}
  let nodesSkipped = 0;
  for (const n of nodes) {
    const buildingId = hex(n.buildingId);
    const id = hex(n._id);
    if (!migratedBuildings.has(buildingId)) {
      nodesSkipped++;
      continue;
    }
    const floorKey = `${buildingId}:${n.floorNumber}`;
    migratedNodes.set(id, {
      buildingId,
      floorNumber: n.floorNumber,
      floorKey,
      x: n.x,
      y: n.y,
      connections: (n.connections || []).map(hex),
    });
    if (!DRY_RUN) {
      await prisma.node.create({
        data: {
          id,
          buildingId,
          floorId: floorIdByKey.get(floorKey),
          x: n.x,
          y: n.y,
          type: NODE_TYPE_MAP[n.type] || 'NORMAL',
          label: n.label || null,
          qrSlug: buildQrSlug(buildingId, n.floorNumber, id),
          scanCount: n.scanCount || 0,
          createdAt: toDate(n.createdAt) || new Date(),
          updatedAt: toDate(n.updatedAt) || new Date(),
        },
      });
    }
  }
  console.log(`nodes: ${migratedNodes.size} migrated, ${nodesSkipped} skipped (unmigrated buildings)`);
  stats.nodes = migratedNodes.size;

  // ------------------------------------------------------------- edges ----
  const edgePairs = new Map(); // "a|b" -> {a, b}
  let dangling = 0;
  let asymmetric = 0;
  for (const [id, node] of migratedNodes) {
    for (const otherId of node.connections) {
      const other = migratedNodes.get(otherId);
      if (!other) {
        dangling++;
        warn(`node ${id} references missing node ${otherId} — edge dropped`);
        continue;
      }
      if (!other.connections.includes(id)) {
        asymmetric++;
        warn(`asymmetric adjacency: ${id} lists ${otherId} but not vice versa — edge kept`);
      }
      if (node.buildingId !== other.buildingId) {
        warn(`cross-building connection ${id} <-> ${otherId} — edge dropped`);
        continue;
      }
      const [a, b] = id < otherId ? [id, otherId] : [otherId, id];
      edgePairs.set(`${a}|${b}`, { a, b });
    }
  }

  console.log(`edges: ${edgePairs.size} unique (${dangling} dangling refs, ${asymmetric} asymmetric)`);
  if (!DRY_RUN) {
    for (const { a, b } of edgePairs.values()) {
      const na = migratedNodes.get(a);
      const nb = migratedNodes.get(b);
      const crossFloor = na.floorNumber !== nb.floorNumber;
      const distance = crossFloor ? 0 : Math.hypot(na.x - nb.x, na.y - nb.y);
      await prisma.edge.create({
        data: {
          sourceNodeId: a,
          targetNodeId: b,
          buildingId: na.buildingId,
          distance,
          weight: crossFloor ? 400 : distance, // FLOOR_CHANGE_COST preserved
          transitType: crossFloor ? 'STAIRS' : 'WALKWAY',
          accessible: !crossFloor, // legacy cross-floor = stairs = not accessible
        },
      });
    }
  }
  stats.edges = edgePairs.size;

  // ------------------------------------------------------- emergencies ----
  const emergencies = await db.collection('emergencies').find({}).toArray();
  let emCount = 0;
  for (const e of emergencies) {
    const buildingId = hex(e.buildingID);
    if (!migratedBuildings.has(buildingId)) continue;
    emCount++;
    if (!DRY_RUN) {
      await prisma.emergencyEvent.create({
        data: {
          id: hex(e._id),
          buildingId,
          status: e.isFinished ? 'RESOLVED' : 'ACTIVE',
          trigger: TRIGGER_MAP[String(e.triggeredBy || 'admin').toLowerCase()] || 'ADMIN',
          scanned: e.scanned || 0,
          evacuated: e.evacuated || 0,
          calledEmergency: e.calledEmergency || 0,
          startedAt: toDate(e.startedAt) || toDate(e.createdAt) || new Date(),
          endedAt: toDate(e.endedAt),
        },
      });
    }
  }
  console.log(`emergencies: ${emCount}`);
  stats.emergencies = emCount;

  // -------------------------------------------------------------- logs ----
  const logs = await db.collection('logs').find({}).toArray();
  let logCount = 0;
  let logSkipped = 0;
  for (const l of logs) {
    const buildingId = hex(l.buildingID);
    if (!migratedBuildings.has(buildingId)) {
      logSkipped++;
      continue;
    }
    logCount++;
    if (!DRY_RUN) {
      await prisma.log.create({
        data: {
          buildingId,
          type: LOG_TYPE_MAP[String(l.logType || 'system').toLowerCase()] || 'SYSTEM',
          message: l.logMessage || '',
          isEmergency: Boolean(l.isEmergency),
          createdAt: toDate(l.createdAt) || new Date(),
        },
      });
    }
  }
  console.log(`logs: ${logCount} migrated, ${logSkipped} skipped`);
  stats.logs = logCount;

  // -------------------------------------------------------- scan events ---
  let scanEvents = 0;
  for (const u of users) {
    for (const s of u.scanned || []) {
      const buildingId = hex(s.buildingID);
      if (!buildingId || !migratedBuildings.has(buildingId)) continue;
      scanEvents++;
      if (!DRY_RUN) {
        await prisma.scanEvent.create({
          data: {
            buildingId,
            userId: hex(u._id),
            buildingName: s.buildingName || '',
            scannedAt: toDate(s.scannedAt) || new Date(),
          },
        });
      }
    }
  }
  for (const b of buildings) {
    const buildingId = hex(b._id);
    if (!migratedBuildings.has(buildingId)) continue;
    for (const g of b.globalScans || []) {
      const userId = hex(g.userID);
      scanEvents++;
      if (!DRY_RUN) {
        await prisma.scanEvent.create({
          data: {
            buildingId,
            userId: userId && userIds.has(userId) ? userId : null,
            buildingName: b.buildingName || '',
            scannedAt: toDate(g.scannedAt) || new Date(),
          },
        });
      }
    }
  }
  console.log(`scan events: ${scanEvents}`);
  stats.scanEvents = scanEvents;

  // ------------------------------------------- reviews/contacts/reports ---
  const reviews = await db.collection('alertup_reviews').find({}).toArray();
  let reviewCount = 0;
  for (const r of reviews) {
    const userId = hex(r.userID);
    reviewCount++;
    if (!DRY_RUN) {
      await prisma.review.create({
        data: {
          userId: userId && userIds.has(userId) ? userId : null,
          userName: r.userName || 'Unknown',
          userType: USER_TYPE_MAP[String(r.userType || '').toLowerCase()] || null,
          stars: r.stars || 1,
          comment: r.comment || null,
          createdAt: toDate(r.createdAt) || new Date(),
        },
      });
    }
  }
  const contacts = await db.collection('contacts').find({}).toArray();
  const reports = await db.collection('reports').find({}).toArray();
  if (!DRY_RUN) {
    for (const c of contacts) {
      await prisma.contact.create({
        data: {
          email: c.email || null,
          message: c.message || null,
          contactType: c.contactType || null,
          createdAt: toDate(c.createdAt) || new Date(),
        },
      });
    }
    for (const r of reports) {
      await prisma.report.create({
        data: {
          email: r.email || null,
          reason: r.reason || null,
          message: r.message || null,
          createdAt: toDate(r.createdAt) || new Date(),
        },
      });
    }
  }
  console.log(`reviews: ${reviewCount}, contacts: ${contacts.length}, reports: ${reports.length}`);
  stats.reviews = reviewCount;
  stats.contacts = contacts.length;
  stats.reports = reports.length;

  // Verifications are deliberately NOT migrated: all are <=10-minute-lived.
  // Anyone mid-2FA/reset at cutover simply restarts the flow.

  console.log('\n===== SUMMARY =====');
  console.table(stats);
  console.log(`Warnings: ${warnings.length}`);
  if (warnings.length) {
    console.log('Review every warning above before cutover.');
  }
  if (DRY_RUN) console.log('DRY RUN — nothing was written.');
}

run()
  .catch((err) => {
    console.error('ETL failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongo.close().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });
