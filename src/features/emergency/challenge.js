import crypto from 'node:crypto';
import config from '../../config/index.js';

/* ============================================================================
   Arming challenge — the human check on the emergency switch.
   ----------------------------------------------------------------------------
   Activating or resolving an emergency broadcasts to every person in the
   building. The routes already sit behind auth, permissions and rate limits;
   what those cannot stop is a mis-tap, a double-fired handler or a replayed
   request arming a whole building by accident. A tiny arithmetic question
   forces a deliberate, present human through the gate.

   The token is HMAC(answer + expiry) under the server secret, so it can't be
   forged. Once solved it is spent (BE-25): the signatures of solved tokens
   are remembered until they expire, so replaying the same request cannot arm
   or resolve twice. That memory is per process, which matches the
   one-machine deployment rule (CLAUDE.md); a restart forgets it, and the
   5-minute expiry bounds what that can allow.
   ========================================================================= */

const TTL_MS = 5 * 60 * 1000;

/** sig → expiresAt for solved tokens. Pruned on every verify. */
const spent = new Map();
const pruneSpent = (now) => {
  for (const [sig, exp] of spent) if (exp < now) spent.delete(sig);
};

const sign = (answer, expiresAt) =>
  crypto
    .createHmac('sha256', `${config.jwt.secret}:emergency-challenge`)
    .update(`${answer}.${expiresAt}`)
    .digest('hex');

/** A fresh question and its sealed token. */
export function createChallenge() {
  const a = 2 + crypto.randomInt(8);
  const b = 2 + crypto.randomInt(8);
  const expiresAt = Date.now() + TTL_MS;
  return {
    question: `${a} + ${b}`,
    token: `${expiresAt}.${sign(a + b, expiresAt)}`,
    ttlSeconds: TTL_MS / 1000,
  };
}

/**
 * True only for the right answer to an unexpired, not-yet-used token. A
 * correct answer spends the token; a wrong one does not, so a mistype can be
 * corrected.
 */
export function verifyChallenge(token, answer) {
  if (typeof token !== 'string') return false;
  const [expStr, sig] = token.split('.');
  const expiresAt = Number(expStr);
  const now = Date.now();
  if (!Number.isFinite(expiresAt) || now > expiresAt) return false;
  const n = Number(answer);
  if (!Number.isInteger(n)) return false;
  pruneSpent(now);
  if (spent.has(sig)) return false;
  const expected = sign(n, expiresAt);
  let valid;
  try {
    valid = crypto.timingSafeEqual(Buffer.from(sig || '', 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
  if (valid) spent.set(sig, expiresAt);
  return valid;
}
