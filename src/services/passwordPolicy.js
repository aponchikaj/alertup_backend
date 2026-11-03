// One rule for every place a password is set: register, settings change and
// reset (FX-080). Login only compares, so existing shorter passwords keep
// working until their owner changes them.
//
// No 16-character ceiling: it rejected passphrases. The real ceiling is
// bcrypt's, which silently ignores everything past 72 bytes.

export const PASSWORD_MIN_CHARS = 8;
export const PASSWORD_MAX_BYTES = 72;

/** @returns {string|null} an error message, or null when the password is acceptable */
export function checkNewPassword(password) {
  if (typeof password !== 'string') return 'Invalid password.';
  if (password.length < PASSWORD_MIN_CHARS) {
    return `Password must be at least ${PASSWORD_MIN_CHARS} characters.`;
  }
  if (Buffer.byteLength(password) > PASSWORD_MAX_BYTES) {
    return `Password must be at most ${PASSWORD_MAX_BYTES} bytes.`;
  }
  return null;
}
