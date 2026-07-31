#!/usr/bin/env node
/**
 * Post-ETL verification: counts, referential spot checks, graph invariants.
 *
 *   node scripts/verify-migration.js
 *
 * Reads BOTH databases (MONGO_STRING + DATABASE_URL) and prints a pass/fail
 * report. Exits non-zero on any failure.
 */

import { MongoClient, ObjectId } from 'mongodb';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config();

const prisma = new PrismaClient();
const mongo = new MongoClient(process.env.MONGO_STRING);

let failures = 0;
const check = (name, condition, detail = '') => {
  const status = condition ? '✅' : '❌';
  console.log(`${status} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
};

const hex = (v) => (v instanceof ObjectId ? v.toHexString() : String(v));
const sample = (arr, n) =>
  [...arr].sort(() => 0.5 - Math.random()).slice(0, Math.min(n, arr.length));

async function run() {
  await mongo.connect();
  const db = mongo.db();

  // ------------------------------------------------------------ counts ----
  const [mUsers, mBuildings, mNodes, mEmergencies, mLogs, mReviews] =
    await Promise.all([
      db.collection('users').countDocuments(),
      db.collection('buildings').countDocuments(),
      db.collection('nodes').countDocuments(),
      db.collection('emergencies').countDocuments(),
      db.collection('logs').countDocuments(),
      db.collection('alertup_reviews').countDocuments(),
    ]);
  const [pUsers, pBuildings, pFloors, pNodes, pEdges, pEmergencies, pLogs, pReviews, pRoles] =
    await Promise.all([
      prisma.user.count(),
      prisma.building.count(),
      prisma.floor.count(),
      prisma.node.count(),
      prisma.edge.count(),
      prisma.emergencyEvent.count(),
      prisma.log.count(),
      prisma.review.count(),
      prisma.role.count(),
    ]);

  check('user count matches', pUsers === mUsers, `mongo ${mUsers} vs pg ${pUsers}`);
  check(
    'building count matches (skipped dangling owners allowed)',
    pBuildings <= mBuildings && pBuildings > 0,
    `mongo ${mBuildings} vs pg ${pBuildings}`
  );
  check('floors exist', pFloors > 0, `${pFloors}`);
  check(
    'node count matches (unmigrated-building nodes allowed to drop)',
    pNodes <= mNodes,
    `mongo ${mNodes} vs pg ${pNodes}`
  );
  check('emergencies count', pEmergencies <= mEmergencies, `mongo ${mEmergencies} vs pg ${pEmergencies}`);
  check('logs count', pLogs <= mLogs, `mongo ${mLogs} vs pg ${pLogs}`);
  check('reviews count', pReviews === mReviews, `mongo ${mReviews} vs pg ${pReviews}`);
  check('roles: 4 system roles per building', pRoles === pBuildings * 4, `${pRoles} roles for ${pBuildings} buildings`);

  // Expected edge count: unique symmetric pairs among migrated nodes.
  const mongoNodes = await db.collection('nodes').find({}).toArray();
  const pgNodeIds = new Set((await prisma.node.findMany({ select: { id: true } })).map((n) => n.id));
  const pairs = new Set();
  for (const n of mongoNodes) {
    const id = hex(n._id);
    if (!pgNodeIds.has(id)) continue;
    for (const c of n.connections || []) {
      const other = hex(c);
      if (!pgNodeIds.has(other)) continue;
      pairs.add(id < other ? `${id}|${other}` : `${other}|${id}`);
    }
  }
  check('edge count equals unique connection pairs', pEdges === pairs.size, `expected ${pairs.size}, got ${pEdges}`);

  // -------------------------------------------------- referential checks --
  for (const n of sample(mongoNodes.filter((x) => pgNodeIds.has(hex(x._id))), 25)) {
    const pg = await prisma.node.findUnique({
      where: { id: hex(n._id) },
      include: { floor: true },
    });
    const okRow =
      pg &&
      pg.x === n.x &&
      pg.y === n.y &&
      pg.buildingId === hex(n.buildingId) &&
      pg.floor.floorNumber === n.floorNumber;
    check(`node spot check ${hex(n._id)}`, Boolean(okRow));
  }

  const mongoUsers = await db.collection('users').find({}).limit(500).toArray();
  for (const u of sample(mongoUsers, 10)) {
    const pg = await prisma.user.findUnique({ where: { id: hex(u._id) } });
    check(
      `user spot check ${hex(u._id)}`,
      Boolean(pg) &&
        pg.email === String(u.email).toLowerCase() &&
        pg.tokenVersion === (u.tokenVersion || 0)
    );
  }

  // ----------------------------------------------------- graph invariants -
  const badEdges = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "Edge" WHERE "sourceNodeId" >= "targetNodeId"`
  );
  check('all edges normalized (source < target)', badEdges[0].n === 0);

  const selfEdges = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "Edge" WHERE "sourceNodeId" = "targetNodeId"`
  );
  check('no self edges', selfEdges[0].n === 0);

  const orphanEdges = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "Edge" e
     LEFT JOIN "Node" s ON s.id = e."sourceNodeId"
     LEFT JOIN "Node" t ON t.id = e."targetNodeId"
     WHERE s.id IS NULL OR t.id IS NULL`
  );
  check('no orphan edges', orphanEdges[0].n === 0);

  // Every node's (buildingId, floor) resolves consistently.
  const inconsistent = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "Node" n
     JOIN "Floor" f ON f.id = n."floorId"
     WHERE f."buildingId" <> n."buildingId"`
  );
  check('node.buildingId consistent with its floor', inconsistent[0].n === 0);

  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run()
  .catch((err) => {
    console.error('Verification failed to run:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongo.close().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });
