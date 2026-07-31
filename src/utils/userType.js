/**
 * Map the userType strings the frontend sends ("Individual" / "Company",
 * historically stored verbatim in Mongo) onto the Postgres enum values
 * (INDIVIDUAL / COMPANY). Accepts legacy strings case-insensitively; returns
 * null for anything unrecognised so callers can reject it at the boundary.
 */
export const normalizeUserType = (value) => {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  if (upper === 'INDIVIDUAL') return 'INDIVIDUAL';
  if (upper === 'COMPANY') return 'COMPANY';
  return null;
};

export const isCompany = (value) => normalizeUserType(value) === 'COMPANY';
export const isIndividual = (value) => normalizeUserType(value) === 'INDIVIDUAL';
