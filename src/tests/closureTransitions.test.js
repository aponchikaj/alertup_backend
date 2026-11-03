import prisma from '../db/prisma.js';
import { subscribe } from '../features/realtime/broadcaster.js';
import { announceClosureTransitions } from '../jobs/closureTransitions.js';
import { createOwnerWithBuilding } from './helpers.js';

// BE-28 follow-up: a closure scheduled for later was announced when it was
// created, but nothing told open scan pages when it actually started or
// ended, so a visitor kept following a route through a corridor that had
// just closed (or around one that had reopened) until they re-scanned.

const ago = (s) => new Date(Date.now() - s * 1000);
const ahead = (s) => new Date(Date.now() + s * 1000);

test('announces scheduled closures that started or ended since the last tick, once', async () => {
  const { building } = await createOwnerWithBuilding();
  const started = await prisma.closure.create({
    data: { buildingId: building.id, reason: 'Cleaning', createdAt: ago(600), startsAt: ago(10) },
  });
  const ended = await prisma.closure.create({
    data: { buildingId: building.id, reason: 'Repairs', startsAt: ago(600), endsAt: ago(5) },
  });
  // Started now with its creation: already announced by the write itself.
  await prisma.closure.create({ data: { buildingId: building.id, reason: 'Spill' } });
  // Not yet.
  await prisma.closure.create({
    data: { buildingId: building.id, reason: 'Later', createdAt: ago(60), startsAt: ahead(600) },
  });

  const seen = [];
  const stop = subscribe(building.id, (msg) => seen.push(msg));
  const now = new Date();
  await announceClosureTransitions(ago(60), now);

  const frames = seen.filter((m) => m.event === 'closure_changed').map((m) => m.data);
  expect(frames).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ closureId: started.id, action: 'started' }),
      expect.objectContaining({ closureId: ended.id, action: 'ended' }),
    ]),
  );
  expect(frames).toHaveLength(2);
  expect(frames.every((f) => !('edgeIds' in f))).toBe(true);

  seen.length = 0;
  await announceClosureTransitions(now, new Date());
  expect(seen.filter((m) => m.event === 'closure_changed')).toHaveLength(0);
  stop();
});
