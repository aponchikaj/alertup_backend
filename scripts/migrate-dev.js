#!/usr/bin/env node
/**
 * `npm run db:migrate -- --name <change>` (FX-029).
 *
 * Creates and applies a migration with `prisma migrate dev`, ONLY against a
 * local Postgres: LOCAL_DATABASE_URL if set, else TEST_DATABASE_URL. Never
 * DATABASE_URL — that is the shared STAGE Supabase, and `migrate dev` may
 * offer to reset a database it thinks has drifted.
 *
 * Shared databases get migrations through `npm run db:deploy`
 * (`prisma migrate deploy`), which only applies committed migrations.
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { assertLocalDatabase } from '../src/utils/dbGuard.js';

const target = process.env.LOCAL_DATABASE_URL || process.env.TEST_DATABASE_URL;
try {
  if (!target) throw new Error('Set LOCAL_DATABASE_URL (or TEST_DATABASE_URL) to a local Postgres.');
  assertLocalDatabase(target, 'prisma migrate dev');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const result = spawnSync('npx', ['prisma', 'migrate', 'dev', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: target },
});
process.exit(result.status ?? 1);
