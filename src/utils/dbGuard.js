/**
 * Guard for destructive database commands (FX-029, FX-070).
 *
 * `prisma migrate dev` can reset a database it thinks has drifted, and the
 * Mongo ETL's `--wipe` truncates every table. Local dev, stage and pre-prod
 * share ONE Supabase database, so either pointed at DATABASE_URL could wipe
 * everybody's data. These commands accept a local Postgres only.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLocalDatabaseUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Host only — never the password — for error messages. */
function hostOf(url) {
  try {
    return new URL(url).hostname || '(no host)';
  } catch {
    return '(unparseable url)';
  }
}

export function assertLocalDatabase(url, purpose) {
  if (isLocalDatabaseUrl(url)) return;
  throw new Error(
    `Refusing to run ${purpose} against "${hostOf(url)}": it only runs against a local Postgres ` +
      '(localhost). Local dev, stage and pre-prod share one Supabase database.'
  );
}
