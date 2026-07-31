// Per-test-file setup (setupFilesAfterEnv).
//
// Repoints DATABASE_URL at the localhost test database and blanks every
// external-service credential so a stray code path can never hit a real
// provider from a test run. The old Mongo version enforced the same property
// against the in-memory server; here the guard is the localhost check.

import dotenv from 'dotenv';

dotenv.config();

if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Start a local PostgreSQL instance with a test database first.'
  );
}
const testHost = new URL(process.env.TEST_DATABASE_URL).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(testHost)) {
  throw new Error('Tests only run against a localhost database.');
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-not-used-in-production';
process.env.SENDGRID_API_KEY = '';
process.env.CLOUDINARY_CLOUD_NAME = '';
process.env.CLOUDINARY_API_KEY = '';
process.env.CLOUDINARY_API_SECRET = '';
process.env.AWS_ACCESS_KEY_ID = '';
process.env.AWS_SECRET_ACCESS_KEY = '';
process.env.GROQ_API_KEY = '';
process.env.ADMIN_USER = process.env.ADMIN_USER || 'test-admin';
process.env.ADMIN_PASS = process.env.ADMIN_PASS || 'test-admin-pass';

const { default: prisma } = await import('../db/prisma.js');

let tableNamesPromise = null;
function loadTableNames() {
  if (!tableNamesPromise) {
    tableNamesPromise = prisma
      .$queryRawUnsafe(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`
      )
      .then((rows) => rows.map((r) => `"${r.tablename}"`));
  }
  return tableNamesPromise;
}

// Truncate everything between tests so ordering cannot matter.
afterEach(async () => {
  const tables = await loadTableNames();
  if (tables.length > 0) {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`
    );
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});
