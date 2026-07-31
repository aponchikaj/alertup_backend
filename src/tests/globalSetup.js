import { execSync } from 'node:child_process';
import dotenv from 'dotenv';

dotenv.config();

// Runs once per Jest invocation: point Prisma at the test database and bring
// its schema up to date. Refuses anything that is not localhost — the same
// "never touch a real deployment" property the old Mongo setup enforced.
export default async function globalSetup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Start a local PostgreSQL instance with a test database and set TEST_DATABASE_URL.'
    );
  }

  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(
      `TEST_DATABASE_URL host is "${host}" — tests only run against localhost.`
    );
  }

  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
