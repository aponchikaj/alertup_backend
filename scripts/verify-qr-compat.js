#!/usr/bin/env node
/**
 * Printed-QR compatibility replay.
 *
 *   node scripts/verify-qr-compat.js [--base-url http://localhost:3001]
 *
 * For EVERY node in Postgres, composes the exact slug a printed sticker would
 * carry (qr_{buildingId}_{floorNumber}_{nodeId}) and calls the live scan
 * endpoint. This is the mandatory pre-cutover gate: it converts "will the
 * stickers on walls keep working?" into a checked list.
 *
 * Passes when every scan returns 200 with the legacy envelope. Nodes with no
 * reachable exit still count as pass (the endpoint returns found:false, which
 * is the legacy behaviour) but are listed for review.
 */

import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { buildQrSlug } from '../src/features/qr/qrPayload.js';

dotenv.config();

const argIndex = process.argv.indexOf('--base-url');
const BASE_URL = (argIndex > -1 && process.argv[argIndex + 1]) || `http://localhost:${process.env.PORT || 3001}`;

const prisma = new PrismaClient();

async function run() {
  const nodes = await prisma.node.findMany({
    include: { floor: { select: { floorNumber: true } } },
  });
  console.log(`Replaying ${nodes.length} node QR slugs against ${BASE_URL} ...`);

  let passed = 0;
  const failuresList = [];
  const noExit = [];

  for (const node of nodes) {
    const slug = buildQrSlug(node.buildingId, node.floor.floorNumber, node.id);
    try {
      const res = await fetch(`${BASE_URL}/api/qr/scan/route/${slug}`);
      const body = await res.json().catch(() => null);
      const envelopeOk =
        res.status === 200 &&
        body?.success === true &&
        body?.data?.nodeId === node.id &&
        body?.data?.buildingId === node.buildingId &&
        Array.isArray(body?.data?.allFloorNodes) &&
        typeof body?.data?.emergencyRoute?.found === 'boolean';

      if (envelopeOk) {
        passed++;
        if (!body.data.emergencyRoute.found) noExit.push(slug);
      } else {
        failuresList.push({ slug, status: res.status, message: body?.message });
      }
    } catch (err) {
      failuresList.push({ slug, status: 'network', message: err.message });
    }
  }

  console.log(`\n✅ ${passed}/${nodes.length} slugs resolved with the legacy envelope.`);
  if (noExit.length) {
    console.log(`\n⚠ ${noExit.length} node(s) have no reachable exit (allowed, review):`);
    noExit.slice(0, 20).forEach((s) => console.log(`   ${s}`));
    if (noExit.length > 20) console.log(`   ... and ${noExit.length - 20} more`);
  }
  if (failuresList.length) {
    console.log(`\n❌ ${failuresList.length} FAILURE(S):`);
    failuresList.forEach((f) => console.log(`   ${f.slug} → ${f.status} ${f.message || ''}`));
    process.exitCode = 1;
  } else {
    console.log('\n✅ QR COMPATIBILITY VERIFIED — safe to cut over.');
  }
}

run()
  .catch((err) => {
    console.error('Replay failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect().catch(() => {}));
