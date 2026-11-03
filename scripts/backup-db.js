#!/usr/bin/env node
/**
 * `npm run db:backup` (FX-029): a pg_dump of DATABASE_URL into backups/
 * (git-ignored), to take before `npm run db:deploy` against a shared
 * database. Custom format, restorable with `pg_restore -d <url> <file>`.
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
const host = new URL(url).hostname;
mkdirSync('backups', { recursive: true });
const file = `backups/${host}-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`;

console.log(`Backing up ${host} to ${file} …`);
const result = spawnSync('pg_dump', ['--format=custom', '--no-owner', `--file=${file}`, url], {
  stdio: 'inherit',
});
if (result.error?.code === 'ENOENT') {
  console.error('pg_dump is not installed (brew install libpq, or the postgresql client).');
  process.exit(1);
}
process.exit(result.status ?? 1);
