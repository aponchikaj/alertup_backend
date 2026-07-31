import { Filter } from 'bad-words';

const filter = new Filter();

/**
 * Validate the name fields for a user, according to their account type.
 *
 * Lifted out of routes/auth/auth.js so registration and settings enforce
 * exactly the same rules — previously registration validated name/lastname
 * while settings validated a `username` field that does not exist on the
 * schema, so profile saves could never succeed.
 *
 * @param {Object} fields
 * @param {'Individual'|'Company'} fields.userType
 * @param {string} [fields.name]
 * @param {string} [fields.lastname]
 * @param {string} [fields.company]
 * @returns {string|null} error message, or null when valid
 */
export const checkNames = ({ userType, name, lastname, company }) => {
  if (userType === 'Individual') {
    const first = (name || '').trim();
    const last = (lastname || '').trim();

    if (first.length < 2 || first.length > 24) return 'Name must be 2-24 characters.';
    if (last.length < 2 || last.length > 24) return 'Lastname must be 2-24 characters.';
    if (filter.isProfane(first) || filter.isProfane(last)) return 'Name contains forbidden words.';

    return null;
  }

  if (userType === 'Company') {
    const companyName = (company || '').trim();

    if (companyName.length < 4 || companyName.length > 50) return 'Company name must be 4-50 characters.';
    if (filter.isProfane(companyName)) return 'Company name contains forbidden words.';

    return null;
  }

  return 'Invalid account type.';
};

/**
 * Basic email shape check, matching the rules registration already applied.
 * @param {string} email
 * @returns {string|null} error message, or null when valid
 */
export const checkEmailFormat = (email) => {
  if (!email) return 'Invalid email.';
  if (email.length < 3 || email.length > 355) return 'Invalid email length.';
  if (!email.includes('@')) return 'Invalid email.';
  return null;
};
