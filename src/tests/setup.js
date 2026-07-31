import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

/**
 * Every test run gets a throwaway in-memory MongoDB.
 *
 * This is a hard safety requirement, not a convenience: the suites call
 * `deleteMany({})` in their setup, and the checked-in .env points MONGO_STRING
 * at the production Atlas cluster. Tests must never be able to reach it.
 */
let mongoServer;

// Neutralise anything that could point the app at a real database or a real
// third-party account, before any module reads these.
process.env.NODE_ENV = 'test';
delete process.env.MONGO_STRING;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-not-used-in-production';
process.env.SENDGRID_API_KEY = '';
process.env.CLOUDINARY_CLOUD_NAME = '';
process.env.CLOUDINARY_API_KEY = '';
process.env.CLOUDINARY_API_SECRET = '';

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  await mongoose.connect(uri);

  // Defence in depth. Importing server.js pulls in `dotenv/config`, which can
  // re-populate MONGO_STRING from the checked-in .env after the delete above.
  // If anything ever re-points mongoose at a remote cluster, fail the run
  // loudly rather than let a `deleteMany({})` reach production data.
  const { host } = mongoose.connection;
  if (host && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(
      `Refusing to run tests: mongoose is connected to "${host}", not an in-memory server.`
    );
  }
});

afterEach(async () => {
  // Clear every collection between tests so ordering cannot matter.
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});
