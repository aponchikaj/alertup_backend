/**
 * Human-readable name for a user.
 *
 * The schema has no `username` field — registration collects name/lastname for
 * an Individual and company for a Company. This is the single place that
 * resolves which of those to show, replacing the copies that were inlined
 * across the auth, 2FA, settings, reviews and admin routes (and the email
 * templates that used to render "Hello undefined").
 *
 * @param {Object} user - a user document or lean object
 * @returns {string} display name, or 'there' as a last-resort greeting fallback
 */
export const displayName = (user) => {
  if (!user) return 'there';

  if (user.userType === 'Company') {
    return (user.company || '').trim() || 'there';
  }

  const full = [user.name, user.lastname]
    .map((part) => (part || '').trim())
    .filter(Boolean)
    .join(' ');

  return full || 'there';
};

export default displayName;
