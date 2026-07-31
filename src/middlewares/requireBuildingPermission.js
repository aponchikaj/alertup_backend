import prisma from '../db/prisma.js';
import { isId } from '../utils/ids.js';
import { fail } from '../utils/respond.js';

// Replaces ownerAuth / ownerOnlyAuth with permission-based checks against the
// building's roles. Owners (buildings.ownerId) hold every permission
// implicitly. Run after whoami.

async function resolveBuildingId(req) {
  const direct =
    req.params.buildingId || req.params.id || req.body?.buildingId || null;
  if (direct) return direct;

  // Node-scoped routes: back the building out of the node.
  const nodeId = req.params.nodeId || req.body?.nodeId || null;
  if (nodeId && isId(nodeId)) {
    const node = await prisma.node.findUnique({
      where: { id: nodeId },
      select: { buildingId: true },
    });
    return node?.buildingId || null;
  }
  // Floor-scoped routes.
  const floorId = req.params.floorId || req.body?.floorId || null;
  if (floorId && isId(floorId)) {
    const floor = await prisma.floor.findUnique({
      where: { id: floorId },
      select: { buildingId: true },
    });
    return floor?.buildingId || null;
  }
  // Edge-scoped routes.
  const edgeId = req.params.edgeId || null;
  if (edgeId && isId(edgeId)) {
    const edge = await prisma.edge.findUnique({
      where: { id: edgeId },
      select: { buildingId: true },
    });
    return edge?.buildingId || null;
  }
  return null;
}

async function loadBuildingContext(req, res) {
  if (!req.user) {
    fail(res, 401, 'Authentication required.');
    return null;
  }

  const buildingId = await resolveBuildingId(req);
  if (!buildingId || !isId(buildingId)) {
    fail(res, 400, 'Invalid building id.');
    return null;
  }

  const building = await prisma.building.findUnique({
    where: { id: buildingId },
    include: {
      members: {
        where: { userId: req.user.id },
        include: { role: true },
      },
    },
  });
  if (!building) {
    fail(res, 404, 'Building not found.');
    return null;
  }

  const isOwner = building.ownerId === req.user.id;
  const membership = building.members[0] || null;

  const { members, ...buildingRow } = building;
  return {
    building: buildingRow,
    isOwner,
    membership,
    permissions: isOwner ? '*' : membership ? membership.role.permissions : [],
  };
}

/**
 * requirePermission('CAN_EDIT_MAP') — grants owners implicitly; members via
 * their role's permission list. Attaches req.building, req.buildingRole,
 * req.buildingPermissions, req.isOwner.
 */
export function requirePermission(permission) {
  return async function requirePermissionMiddleware(req, res, next) {
    try {
      const ctx = await loadBuildingContext(req, res);
      if (!ctx) return;

      const allowed =
        ctx.permissions === '*' || ctx.permissions.includes(permission);
      if (!allowed) {
        return fail(res, 403, 'You do not have permission to do that.');
      }

      req.building = ctx.building;
      req.isOwner = ctx.isOwner;
      req.buildingRole = ctx.isOwner ? 'OWNER' : ctx.membership?.role?.name || null;
      req.buildingPermissions =
        ctx.permissions === '*' ? '*' : ctx.permissions;
      next();
    } catch (err) {
      console.error('requirePermission error:', err);
      return fail(res, 500, 'Server error.');
    }
  };
}

/** Owner-only guard for destructive/ownership operations. */
export async function requireOwner(req, res, next) {
  try {
    const ctx = await loadBuildingContext(req, res);
    if (!ctx) return;
    if (!ctx.isOwner) {
      return fail(res, 403, 'Only the building owner can do that.');
    }
    req.building = ctx.building;
    req.isOwner = true;
    req.buildingRole = 'OWNER';
    req.buildingPermissions = '*';
    next();
  } catch (err) {
    console.error('requireOwner error:', err);
    return fail(res, 500, 'Server error.');
  }
}

/** Any-member guard (owner or any role) — e.g. the realtime admin feed. */
export async function requireMembership(req, res, next) {
  try {
    const ctx = await loadBuildingContext(req, res);
    if (!ctx) return;
    if (!ctx.isOwner && !ctx.membership) {
      return fail(res, 403, 'You are not a member of this building.');
    }
    req.building = ctx.building;
    req.isOwner = ctx.isOwner;
    req.buildingRole = ctx.isOwner ? 'OWNER' : ctx.membership.role.name;
    req.buildingPermissions = ctx.permissions === '*' ? '*' : ctx.permissions;
    next();
  } catch (err) {
    console.error('requireMembership error:', err);
    return fail(res, 500, 'Server error.');
  }
}
