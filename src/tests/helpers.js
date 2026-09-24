import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import prisma from '../db/prisma.js';
import { SYSTEM_ROLES } from '../auth/permissions.js';
import { buildQrSlug } from '../features/qr/qrPayload.js';

/**
 * Shared fixtures for API tests, Prisma edition. Passwords are hashed with a
 * low cost factor (speed) and session cookies are minted directly rather than
 * driving the login flow.
 */

export const TEST_PASSWORD = 'password123';

let counter = 0;
const unique = () => `${Date.now().toString(36)}-${(counter++).toString(36)}`;

export const createUser = async (overrides = {}) => {
  const { password: rawPassword, ...rest } = overrides;
  const password = rawPassword || TEST_PASSWORD;
  const user = await prisma.user.create({
    data: {
      userType: 'INDIVIDUAL',
      name: 'Test',
      lastname: 'Owner',
      email: `user-${unique()}@example.com`,
      password: await bcrypt.hash(password, 4),
      country: 'Georgia',
      countryCode: '+995',
      phone: '500000000',
      verified: true,
      ...rest,
    },
  });

  const token = jwt.sign(
    { userID: user.id, tokenVersion: user.tokenVersion },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  return { user, token, cookie: [`userToken=${token}`], plainPassword: password };
};

export const adminCookie = () => {
  const token = jwt.sign({ isAdmin: true }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return [`adminToken=${token}`];
};

/** Seed the standard system roles for a building; returns them keyed by name. */
export const seedSystemRoles = async (buildingId) => {
  const roles = {};
  for (const spec of SYSTEM_ROLES) {
    roles[spec.name] = await prisma.role.create({
      data: {
        buildingId,
        name: spec.name,
        permissions: [...spec.permissions],
        isSystem: true,
      },
    });
  }
  return roles;
};

export const createBuilding = async (ownerId, overrides = {}) => {
  const building = await prisma.building.create({
    data: {
      name: 'Test Building',
      ownerId,
      ...overrides,
    },
  });
  const roles = await seedSystemRoles(building.id);
  return { building, roles };
};

export const createFloor = async (buildingId, overrides = {}) =>
  prisma.floor.create({
    data: {
      buildingId,
      floorNumber: overrides.floorNumber ?? 1,
      name: overrides.name ?? String(overrides.floorNumber ?? 1),
      width: overrides.width ?? 1000,
      height: overrides.height ?? 800,
      ...overrides,
    },
  });

/** `overrides` is spread last, so `visibility`, `externalId`, `label`, `qrSlug`
 *  and friends pass straight through to the row. */
export const createNode = async (buildingId, floorId, overrides = {}) =>
  prisma.node.create({
    data: {
      buildingId,
      floorId,
      x: 100,
      y: 100,
      type: 'NORMAL',
      ...overrides,
    },
  });

/**
 * Edge fixture. The pair is normalized (source < target) the way
 * `edgeService.createEdge` does, so `direction: 'FORWARD'` means
 * "from the lower id to the higher one" — read `edge.sourceNodeId` back when a
 * test needs to know which end is which.
 */
export const connectNodes = async (a, b, overrides = {}) => {
  const [sourceNodeId, targetNodeId] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
  const distance = overrides.distance ?? Math.hypot(a.x - b.x, a.y - b.y);
  return prisma.edge.create({
    data: {
      sourceNodeId,
      targetNodeId,
      buildingId: a.buildingId,
      distance,
      weight: overrides.weight ?? distance,
      accessible: overrides.accessible ?? true,
      transitType: overrides.transitType || 'WALKWAY',
      ...(overrides.direction ? { direction: overrides.direction } : {}),
      ...(overrides.tags ? { tags: overrides.tags } : {}),
      ...(overrides.rank ? { rank: overrides.rank } : {}),
      ...(overrides.visibility ? { visibility: overrides.visibility } : {}),
      ...(overrides.lengthM !== undefined ? { lengthM: overrides.lengthM } : {}),
    },
  });
};

export const addMember = async (buildingId, userId, roleId) =>
  prisma.buildingMember.create({ data: { buildingId, userId, roleId } });

/** A verified owner with a building (plus seeded system roles). */
export const createOwnerWithBuilding = async () => {
  const { user, token, cookie } = await createUser();
  const { building, roles } = await createBuilding(user.id);
  return { user, token, cookie, building, roles };
};

/** Build the scan id a printed QR encodes. */
export const qrIdFor = (node, floorNumber) =>
  buildQrSlug(node.buildingId, floorNumber, node.id);
