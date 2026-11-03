import prisma from '../db/prisma.js';
import { sweepOnce, UNVERIFIED_ACCOUNT_TTL_MS } from '../jobs/sweeper.js';
import { createUser, createOwnerWithBuilding, addMember } from './helpers.js';

/* ============================================================================
   FX-019 — an unverified account cannot sit on someone else's email forever.

   Registration takes an address without proving the registrant owns it, so
   anyone could register first and block the real owner from signing up (or
   from accepting an invite sent to that address). Accounts that never verify
   their email within UNVERIFIED_ACCOUNT_TTL_MS, and hold nothing (no
   buildings, memberships or sent invites), are removed by the sweeper,
   freeing the address.
   ========================================================================= */

const age = (userId, ms) =>
  prisma.user.update({ where: { id: userId }, data: { createdAt: new Date(Date.now() - ms) } });

test('an old, unverified, empty account is removed', async () => {
  const { user } = await createUser({ verified: false });
  await age(user.id, UNVERIFIED_ACCOUNT_TTL_MS + 60_000);

  await sweepOnce();

  expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
});

test('a recent unverified account is kept', async () => {
  const { user } = await createUser({ verified: false });

  await sweepOnce();

  expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
});

test('an old verified account is kept', async () => {
  const { user } = await createUser();
  await age(user.id, UNVERIFIED_ACCOUNT_TTL_MS * 10);

  await sweepOnce();

  expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
});

test('an old unverified account that belongs to a team is kept', async () => {
  const { building, roles } = await createOwnerWithBuilding();
  const { user } = await createUser({ verified: false });
  await addMember(building.id, user.id, Object.values(roles)[0].id);
  await age(user.id, UNVERIFIED_ACCOUNT_TTL_MS + 60_000);

  await sweepOnce();

  expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
});
