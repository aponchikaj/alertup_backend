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

   Stateless by design: the token is HMAC(answer + expiry) under the server
   secret, so verification needs no session storage and survives restarts —
   the same property the JWT auth relies on.
   ========================================================================= */

const TTL_MS = 5 * 60 * 1000;

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

/** True only for the right answer to an unexpired token. */
export function verifyChallenge(token, answer) {
  if (typeof token !== 'string') return false;
  const [expStr, sig] = token.split('.');
  const expiresAt = Number(expStr);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  const n = Number(answer);
  if (!Number.isInteger(n)) return false;
  const expected = sign(n, expiresAt);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig || '', 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}
