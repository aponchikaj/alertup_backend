// Canonical permission keys. Role.permissions[] rows are validated against
// this list — the DB stores strings, the code owns the vocabulary.

export const PERMISSIONS = Object.freeze({
  CAN_TRIGGER_EMERGENCY: 'CAN_TRIGGER_EMERGENCY',
  CAN_EDIT_MAP: 'CAN_EDIT_MAP',
  CAN_INVITE_USERS: 'CAN_INVITE_USERS',
  CAN_MANAGE_ROLES: 'CAN_MANAGE_ROLES',
  CAN_VIEW_ANALYTICS: 'CAN_VIEW_ANALYTICS',
});

export const ALL_PERMISSIONS = Object.freeze(Object.values(PERMISSIONS));

export function isValidPermission(value) {
  return ALL_PERMISSIONS.includes(value);
}

// The five roles seeded per building at creation/migration time. Owner is not
// a role: buildings.ownerId implies every permission. "Building Admin" is the
// closest seeded equivalent for delegation.
export const SYSTEM_ROLES = Object.freeze([
  { name: 'Building Admin', permissions: ALL_PERMISSIONS },
  {
    name: 'Security Officer',
    permissions: [PERMISSIONS.CAN_TRIGGER_EMERGENCY, PERMISSIONS.CAN_VIEW_ANALYTICS],
  },
  {
    name: 'Moderator',
    permissions: [PERMISSIONS.CAN_EDIT_MAP, PERMISSIONS.CAN_VIEW_ANALYTICS],
  },
  { name: 'Viewer', permissions: [PERMISSIONS.CAN_VIEW_ANALYTICS] },
]);

// Anti-escalation: an actor may only create/edit/assign roles whose
// permissions are a subset of the actor's own. Owners bypass this check.
export function isSubset(candidate, actorPermissions) {
  const held = new Set(actorPermissions);
  return candidate.every((p) => held.has(p));
}
