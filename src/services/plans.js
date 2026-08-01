/**
 * Plan capacity rules — one table, imported everywhere a limit is enforced.
 *
 * Plans gate CAPACITY, never safety: evacuation routing, emergency mode and
 * QR scanning work identically on every tier. What scales with price is how
 * much building you can model.
 */
export const PLAN_LIMITS = Object.freeze({
  FREE: Object.freeze({ maxBuildings: 1, maxFloorsPerBuilding: 2 }),
  STARTER: Object.freeze({ maxBuildings: 3, maxFloorsPerBuilding: 4 }),
  BUSINESS: Object.freeze({ maxBuildings: 10, maxFloorsPerBuilding: 10 }),
});

const limitsFor = (plan) => PLAN_LIMITS[plan] || PLAN_LIMITS.FREE;

export const floorLimitFor = (plan) => limitsFor(plan).maxFloorsPerBuilding;
export const buildingLimitFor = (plan) => limitsFor(plan).maxBuildings;

/** The AI floor designer is the flagship of the paid tiers. */
export const aiDesignerAllowed = (plan) => plan === 'STARTER' || plan === 'BUSINESS';
