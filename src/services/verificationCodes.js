import bcrypt from 'bcrypt';
import crypto from 'crypto';
import prisma from '../db/prisma.js';

/**
 * Shared verification-code plumbing for the 2FA / password-reset /
 * email-change / account-verification flows.
 *
 * Codes are 6-digit values from a CSPRNG (Math.random() is an xorshift128+
 * PRNG whose state is recoverable from a few observed outputs) and are stored
 * bcrypt-hashed — a verification code is a temporary credential and must not
 * be readable from the database.
 *
 * The Mongo TTL index is gone: every lookup filters `expiresAt > now()` and a
 * sweeper job deletes expired rows. Routes still compare expiry defensively.
 */

export const generateCode = () => crypto.randomInt(100000, 1000000);

/** Wrong guesses allowed against a single code before it is destroyed. */
export const MAX_CODE_ATTEMPTS = 5;

export const CODE_TTL_MS = 5 * 60 * 1000; // 2FA login/activation codes
export const LONG_CODE_TTL_MS = 10 * 60 * 1000; // reset / email-change / verify

/**
 * Replace any pending verification of `type` for the user with a fresh one.
 * Returns the plaintext code (for the email) and the created row.
 */
export const issueVerification = async ({ userId, type, ttlMs = CODE_TTL_MS, pendingEmail = null }) => {
  await prisma.verification.deleteMany({ where: { userId, type } });

  const code = generateCode();
  const verification = await prisma.verification.create({
    data: {
      userId,
      type,
      codeHash: await bcrypt.hash(String(code), 12),
      pendingEmail,
      expiresAt: new Date(Date.now() + ttlMs),
    },
  });

  return { code, verification };
};

/** Pending, unexpired verification of `type` for the user (or null). */
export const findActiveVerification = (userId, type, extraWhere = {}) =>
  prisma.verification.findFirst({
    where: { userId, type, expiresAt: { gt: new Date() }, ...extraWhere },
  });

/** Constant-shape compare of a submitted code against a verification row. */
export const compareCode = (submitted, verification) =>
  bcrypt.compare(String(submitted), verification.codeHash);

/**
 * Record a wrong guess. Destroys the code once the attempt cap is reached —
 * the IP-keyed rate limiter alone does not stop an attacker rotating source
 * addresses through a 6-digit space. Returns true when the code was destroyed.
 */
export const recordFailedAttempt = async (verification, max = MAX_CODE_ATTEMPTS) => {
  const updated = await prisma.verification.update({
    where: { id: verification.id },
    data: { attempts: { increment: 1 } },
  });
  if (updated.attempts >= max) {
    await prisma.verification.delete({ where: { id: verification.id } }).catch(() => {});
    return true;
  }
  return false;
};
