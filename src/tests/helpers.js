import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import USERS from '../models/user.model.js';
import BUILDINGS from '../models/building.model.js';
import Node from '../models/node.model.js';

/**
 * Shared fixtures for API tests.
 *
 * The suites this replaces each created a user with a plaintext password and
 * then tried to log in to obtain a token — which can never work, because login
 * bcrypt-compares against a hash. Here the password is hashed properly and the
 * session cookie is minted directly, which is both correct and faster.
 */

export const TEST_PASSWORD = 'password123';

/**
 * Create a verified user and return an auth cookie for them.
 * @param {Object} [overrides] - fields to override on the user document
 */
export const createUser = async (overrides = {}) => {
  const user = await USERS.create({
    userType: 'Individual',
    name: 'Test',
    lastname: 'Owner',
    email: `user-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    password: await bcrypt.hash(TEST_PASSWORD, 10),
    country: 'Georgia',
    countryCode: '+995',
    phones: '500000000',
    verified: true,
    ...overrides,
  });

  const token = jwt.sign({ userID: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });

  return { user, token, cookie: [`userToken=${token}`] };
};

/**
 * Create a building owned by the given user.
 */
export const createBuilding = async (ownerId, overrides = {}) => {
  const building = await BUILDINGS.create({
    buildingName: 'Test Building',
    owner: ownerId,
    floors: 2,
    maps: [
      { floor: '1', map: null, qrCode: 'test-qr-1', scanned: 0 },
      { floor: '2', map: null, qrCode: 'test-qr-2', scanned: 0 },
    ],
    ...overrides,
  });

  await USERS.findByIdAndUpdate(ownerId, { $push: { Buildings: building._id } });
  return building;
};

/**
 * Create a node.
 */
export const createNode = async (buildingId, overrides = {}) => {
  return Node.create({
    buildingId,
    floorNumber: 1,
    x: 100,
    y: 100,
    type: 'path',
    connections: [],
    ...overrides,
  });
};

/**
 * A verified owner with a building, ready for authenticated requests.
 */
export const createOwnerWithBuilding = async () => {
  const { user, token, cookie } = await createUser();
  const building = await createBuilding(user._id);
  return { user, token, cookie, building };
};

/** Build the scan id a printed QR encodes. */
export const qrIdFor = (node) => `qr_${node.buildingId}_${node.floorNumber}_${node._id}`;
