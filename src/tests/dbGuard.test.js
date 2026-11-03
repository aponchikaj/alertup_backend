import { spawnSync } from 'node:child_process';
import { isLocalDatabaseUrl, assertLocalDatabase } from '../utils/dbGuard.js';

/* ============================================================================
   FX-029 / FX-070 — destructive database commands only ever touch a local
   database.

   `npm run db:migrate` ran `prisma migrate dev` against DATABASE_URL — the
   shared STAGE Supabase that local dev, stage and pre-prod all use — and
   `migrate dev` offers to RESET a database when it detects drift. The Mongo
   ETL's `--wipe` truncated whatever DATABASE_URL pointed at. Both now refuse
   anything that is not a local Postgres.
   ========================================================================= */

describe('isLocalDatabaseUrl', () => {
  test.each([
    'postgresql://u:p@localhost:5432/alertup_test',
    'postgresql://u:p@127.0.0.1/x',
    'postgres://u:p@[::1]:5432/x',
  ])('accepts %s', (url) => {
    expect(isLocalDatabaseUrl(url)).toBe(true);
  });

  test.each([
    'postgresql://postgres.abc:p%40ss@aws-0-eu-central-1.pooler.supabase.com:5432/postgres',
    'postgresql://u:p@db.example.com/x',
    'postgresql://u:p@localhost.evil.com/x',
    '',
    undefined,
    'not a url',
  ])('refuses %s', (url) => {
    expect(isLocalDatabaseUrl(url)).toBe(false);
  });
});

test('assertLocalDatabase names the purpose and never prints the password', () => {
  const url = 'postgresql://postgres.abc:SuperSecret@aws-0.pooler.supabase.com:5432/postgres';
  expect(() => assertLocalDatabase(url, 'prisma migrate dev')).toThrow(/prisma migrate dev/);
  try {
    assertLocalDatabase(url, 'prisma migrate dev');
  } catch (err) {
    expect(err.message).not.toContain('SuperSecret');
  }
});

test('npm run db:migrate refuses a remote database without running prisma', () => {
  const result = spawnSync(process.execPath, ['scripts/migrate-dev.js', '--name', 'x'], {
    env: {
      PATH: process.env.PATH,
      LOCAL_DATABASE_URL: 'postgresql://u:p@aws-0.pooler.supabase.com:5432/postgres',
      TEST_DATABASE_URL: '',
      DOTENV_CONFIG_PATH: '/nonexistent',
    },
    encoding: 'utf8',
  });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/local/i);
});
