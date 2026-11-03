import express from 'express';
import { buildingLimitFor, floorLimitFor } from '../../services/plans.js';
import QRCode from 'qrcode';
import { Filter } from 'bad-words';
import prisma from '../../db/prisma.js';
import config from '../../config/index.js';
import upload, { imageExtFor } from '../../middlewares/buildingUpload.js';
import whoami from '../../middlewares/whoami.js';
import {
  requireOwner,
  requirePermission,
} from '../../middlewares/requireBuildingPermission.js';
import { PERMISSIONS, SYSTEM_ROLES } from '../../auth/permissions.js';
import { isId } from '../../utils/ids.js';
import { resolveSession } from '../../utils/session.js';
import { reservedFloorNameError } from '../../services/floorNames.js';
import { ok, fail } from '../../utils/respond.js';
import { uploadBuffer, deleteByUrl, keys } from '../../services/storage.js';
import { displayName } from '../../services/displayName.js';
import { publicReadLimiter } from '../../services/rateLimiter.js';
import { publish } from '../../features/realtime/broadcaster.js';
import { invalidate } from '../../features/wayfinding/graphCache.js';
import { archiveIncidents } from '../../services/incidentArchive.js';

const router = express.Router();

/* ---------------- HELPERS ---------------- */

// LEGACY COMPATIBILITY: the deployed frontend reads `buildingName`, `owner`,
// `maps[]` ({floor, map, qrCode, scanned, createdAt}) and `Message`/`Success`
// envelopes on these routes. The Prisma columns are name/ownerId/Floor rows —
// everything below synthesizes the old shape from the new tables.

/** Legacy maps[] entry synthesized from a Floor row. */
export const legacyMapEntry = (floor) => ({
  floor: floor.name || String(floor.floorNumber),
  map: floor.mapImageUrl,
  qrCode: floor.qrCodeUrl,
  scanned: floor.scanCount,
  createdAt: floor.createdAt,
});

/**
 * The Floor columns legacyMapEntry/legacyBuilding read. Floor rows also carry
 * svgContent and drawing, the largest columns in the database, so these
 * routes must never load whole rows (FX-093).
 */
const LEGACY_FLOOR_SELECT = {
  id: true,
  name: true,
  floorNumber: true,
  mapImageUrl: true,
  qrCodeUrl: true,
  scanCount: true,
  createdAt: true,
};

/**
 * Legacy building document synthesized from a Building row plus its Floor
 * rows (ordered by floorNumber).
 */
export const legacyBuilding = (building, floors = []) => ({
  _id: building.id,
  id: building.id,
  buildingName: building.name,
  owner: building.ownerId,
  floors: floors.length,
  maps: floors.map(legacyMapEntry),
  globalScans: [],
  emergencyMode: building.emergencyMode,
  isDeactivated: building.isDeactivated,
  createdAt: building.createdAt,
  updatedAt: building.updatedAt,
});

/** The URL a floor QR encodes — same shape the printed codes already use. */
const floorQrDataUrl = (buildingId, floorName) =>
  QRCode.toDataURL(
    `${config.urls.appBase.replace(/\/+$/, '')}/building/${buildingId}/${encodeURIComponent(floorName)}`
  );

// Check building name validity
const checkBuildingName = async (userId, buildingName, buildingId = null) => {
  if (!userId || !buildingName || typeof buildingName !== 'string')
    return 'Something went wrong.';

  buildingName = buildingName.trim();
  if (buildingName.length < 4 || buildingName.length > 40)
    return 'Building name must have from 4 to 40 characters.';

  const filter = new Filter();
  if (filter.isProfane(buildingName)) return 'Building name contains bad words.';

  const exists = await prisma.building.findFirst({
    where: {
      ownerId: userId,
      name: buildingName,
      ...(buildingId ? { NOT: { id: buildingId } } : {}),
    },
    select: { id: true },
  });
  if (exists) return 'Building name already exists in your buildings.';

  return true;
};

/**
 * Coerce the floorNames field to an array of trimmed strings.
 *
 * In a multipart request a field sent exactly once arrives as a bare string,
 * not a one-element array, so single-floor buildings were rejected outright
 * unless the client happened to use `floorNames[]` bracket notation.
 */
const normalizeFloorNames = (floorNames) => {
  if (floorNames === undefined || floorNames === null) return [];
  const list = Array.isArray(floorNames) ? floorNames : [floorNames];
  return list.filter((f) => typeof f === 'string').map((f) => f.trim()).filter(Boolean);
};

/** Best-effort S3 cleanup — never lets a failed delete break the request. */
const deleteAssetQuietly = async (url, buildingId) => {
  if (!url) return;
  try {
    await deleteByUrl(url, { buildingId });
  } catch (err) {
    console.error('Asset cleanup failed:', err.message);
  }
};

/* ---------------- CREATE BUILDING ---------------- */
router.post('/api/building/new', whoami, upload.array('maps'), async (req, res) => {
  try {
    if (req.user.verified === false)
      return fail(res, 200, 'Verify account first.');

    // Capacity per plan: the free tier maps one building end to end; paid
    // tiers scale out. Checked again under a lock inside the transaction
    // below; this early read only spares a doomed request the validation.
    const planLimits = buildingLimitFor(req.user.plan);
    const planLimitMessage = `Your plan allows up to ${planLimits} building${planLimits === 1 ? '' : 's'}. Upgrade to add more.`;
    if ((await prisma.building.count({ where: { ownerId: req.user.id } })) >= planLimits) {
      return fail(res, 200, planLimitMessage);
    }

    // Plan floor cap applies to the floors created with the building too.
    const floorCap = floorLimitFor(req.user.plan);

    const { buildingName } = req.body;
    if (!buildingName || typeof buildingName !== 'string')
      return fail(res, 200, 'Invalid building name.');

    const floorNames = normalizeFloorNames(req.body.floorNames);
    if (floorNames.length === 0)
      return fail(res, 200, 'Invalid floor names.');

    if (floorNames.length > floorCap) {
      return fail(res, 200, `Your plan allows up to ${floorCap} floors per building. Upgrade to add more.`,);
    }

    for (const name of floorNames) {
      const reserved = reservedFloorNameError(name);
      if (reserved) return fail(res, 200, reserved);
    }

    const normalizedFloors = floorNames.map((f) => f.toLowerCase());
    if (new Set(normalizedFloors).size !== normalizedFloors.length)
      return fail(res, 200, 'Floor names must be unique.');

    const nameCheck = await checkBuildingName(req.user.id, buildingName);
    if (nameCheck !== true) return fail(res, 200, nameCheck);

    const files = req.files || [];
    if (files.length > floorNames.length)
      return fail(res, 200, 'Too many map files uploaded.');

    // Building, its four system roles and every floor commit together or not
    // at all (BE-38): a half-created building is a stuck state for its owner.
    // The owner's User row is locked first, so parallel creates by the same
    // user serialize and the plan count below cannot be raced past.
    const created = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.user.id} FOR UPDATE`;
      if ((await tx.building.count({ where: { ownerId: req.user.id } })) >= planLimits) {
        return null;
      }

      const building = await tx.building.create({
        data: {
          name: buildingName.trim(),
          ownerId: req.user.id,
          roles: {
            create: SYSTEM_ROLES.map((role) => ({
              name: role.name,
              permissions: [...role.permissions],
              isSystem: true,
            })),
          },
        },
      });

      const floors = [];
      for (let i = 0; i < floorNames.length; i++) {
        floors.push(
          await tx.floor.create({
            data: {
              buildingId: building.id,
              floorNumber: i + 1,
              name: floorNames[i],
              qrCodeUrl: await floorQrDataUrl(building.id, floorNames[i]),
            },
            select: { id: true, name: true },
          })
        );
      }
      return { building, floors };
    });
    if (!created) return fail(res, 200, planLimitMessage);
    const { building, floors } = created;

    // Uploads run after commit: storage is not transactional, and a failed
    // upload leaves that floor's map null rather than failing the creation.
    for (let i = 0; i < floors.length; i++) {
      const file = files[i];
      if (!file) continue;
      const floor = floors[i];
      try {
        const ext = imageExtFor(file.mimetype) || 'bin';
        const mapUrl = await uploadBuffer({
          key: keys.floorMap(building.id, floor.id, ext),
          buffer: file.buffer,
          contentType: file.mimetype,
        });
        await prisma.floor.update({
          where: { id: floor.id },
          data: { mapImageUrl: mapUrl },
        });
      } catch (error) {
        console.error(`Failed to upload floor ${floor.name} map:`, error);
      }
    }

    return ok(res, {
      message: 'Building created successfully.',
      extra: { buildingID: building.id },
    });
  } catch (error) {
    console.error(error);
    return fail(res, 200, 'Server error.');
  }
});

/* ---------------- GET BUILDING BY ID ---------------- */
// Public on purpose: an occupant scanning a QR has no account, and the
// frontend BuildingOwnerGuard compares `Message.owner` against the current
// user id. So the building stays readable, but the owner is reduced to an id
// plus a display name — never their email, phone, or scan history.
router.get('/api/building/id/:buildingID', publicReadLimiter, async (req, res) => {
  const { buildingID } = req.params;

  try {
    if (!buildingID || !isId(buildingID)) {
      return fail(res, 200, 'Invalid building ID.');
    }

    const building = await prisma.building.findUnique({
      where: { id: buildingID },
      include: {
        floors: { orderBy: { floorNumber: 'asc' }, select: LEGACY_FLOOR_SELECT },
        owner: { select: { id: true, name: true, lastname: true, company: true, userType: true } },
      },
    });
    if (!building) return fail(res, 200, 'Building not found.');
    if (!building.owner) return fail(res, 200, 'Owner data missing.');

    return ok(res, {
      data: legacyBuilding(building, building.floors),
      extra: {
        Owner: {
          _id: building.owner.id,
          displayName: displayName(building.owner),
          userType: building.owner.userType,
        },
      },
    });
  } catch (error) {
    console.error('GET /api/building/id/:buildingID error:', error);
    return fail(res, 200, 'Server error.');
  }
});

/* ---------------- GET MY BUILDINGS ---------------- */
router.get('/api/building/my', whoami, async (req, res) => {
  try {
    const owned = await prisma.building.findMany({
      where: { ownerId: req.user.id },
      include: { floors: { orderBy: { floorNumber: 'asc' }, select: LEGACY_FLOOR_SELECT } },
      orderBy: { createdAt: 'desc' },
    });

    // Additive: buildings the user belongs to through a role (RBAC). The
    // deployed frontend ignores unknown fields, so this is non-breaking.
    const memberships = await prisma.buildingMember.findMany({
      where: { userId: req.user.id },
      include: {
        building: { include: { floors: { orderBy: { floorNumber: 'asc' }, select: LEGACY_FLOOR_SELECT } } },
        role: { select: { name: true, permissions: true } },
      },
    });

    return ok(res, {
      data: owned.map((b) => legacyBuilding(b, b.floors)),
      extra: {
        memberBuildings: memberships.map((m) => ({
          ...legacyBuilding(m.building, m.building.floors),
          role: m.role.name,
          permissions: m.role.permissions,
        })),
      },
    });
  } catch (err) {
    console.error(err);
    return fail(res, 200, 'Server error');
  }
});

/** The signed-in user id from a session cookie, or null. Never throws. */
const userIdFromToken = async (token) => {
  if (!token) return null;
  try {
    return (await resolveSession(token)).user?.id || null;
  } catch {
    return null;
  }
};

/* ---------------- SCAN FLOOR (legacy scheme B: floor by NAME) ---------------- */
router.get('/api/building/scan/:id/:floor', publicReadLimiter, async (req, res) => {
  const { id, floor } = req.params;
  try {
    if (!id || !isId(id))
      return fail(res, 400, 'Invalid building id.');

    const building = await prisma.building.findUnique({
      where: { id },
      include: { floors: { orderBy: { floorNumber: 'asc' }, select: LEGACY_FLOOR_SELECT } },
    });
    if (!building)
      return fail(res, 404, 'Building not found.');

    // A deactivated building is honored rather than silently switched back on.
    // This endpoint is anonymous, so reactivating here would let any passer-by
    // undo the owner-only deactivation and get served stale evacuation data.
    if (building.isDeactivated) {
      return fail(res, 410, 'This building is currently deactivated.');
    }

    // The printed floor QR carries the floor NAME. Resolve by name first, then
    // by number, then fall back to the first floor (old maps[0] fallback).
    let floorRow =
      building.floors.find((f) => (f.name || String(f.floorNumber)) === floor) || null;
    if (!floorRow) {
      const parsed = parseInt(floor, 10);
      if (!Number.isNaN(parsed)) {
        floorRow = building.floors.find((f) => f.floorNumber === parsed) || null;
      }
    }
    if (!floorRow) floorRow = building.floors[0] || null;
    if (!floorRow)
      return fail(res, 404, 'Floor not found.');

    // FX-022: this page is both the landing page for a printed floor QR AND
    // the admin floor view. Only a visitor's scan counts — the building's own
    // owner or members looking at their map in the dashboard must not inflate
    // scanCount, ScanEvents, or (during an emergency) the incident log.
    const viewerId = await userIdFromToken(req.cookies?.['userToken']);
    const isStaffView =
      Boolean(viewerId) &&
      (building.ownerId === viewerId ||
        Boolean(
          await prisma.buildingMember.findUnique({
            where: { buildingId_userId: { buildingId: building.id, userId: viewerId } },
            select: { userId: true },
          })
        ));
    if (isStaffView) {
      return ok(res, {
        data: {
          buildingName: building.name,
          floorData: legacyMapEntry(floorRow),
          scannedCount: floorRow.scanCount,
        },
      });
    }

    const updatedFloor = await prisma.floor.update({
      select: LEGACY_FLOOR_SELECT,
      where: { id: floorRow.id },
      data: { scanCount: { increment: 1 } },
    });

    if (building.emergencyMode === true) {
      try {
        const message = 'Floor QR has been scanned.';
        await prisma.$transaction([
          prisma.log.create({
            data: { buildingId: building.id, type: 'SCAN', isEmergency: true, message },
          }),
          prisma.emergencyEvent.updateMany({
            where: { buildingId: building.id, status: 'ACTIVE' },
            data: { scanned: { increment: 1 } },
          }),
        ]);
        publish(building.id, 'log_appended', {
          message,
          type: 'SCAN',
          createdAt: new Date().toISOString(),
        });
      } catch (logErr) {
        console.error('Failed to record emergency scan:', logErr.message);
      }
    }

    // Same rule as the QR scan route: every visitor scan is recorded (FX-094),
    // attributed only through a valid session, and a failure here must never
    // turn a successful floor lookup into a 500.
    try {
      const userToken = req.cookies['userToken'];
      const session = userToken ? await resolveSession(userToken) : null;
      await prisma.scanEvent.create({
        data: {
          buildingId: building.id,
          userId: session?.user?.id ?? null,
          buildingName: building.name,
        },
      });
    } catch (scanErr) {
      console.warn('Scan event not recorded:', scanErr.message);
    }

    const floorData = legacyMapEntry(updatedFloor);
    return ok(res, {
      data: {
        buildingName: building.name,
        floorData,
        scannedCount: updatedFloor.scanCount,
      },
    });
  } catch (error) {
    console.error('GET /api/building/scan/:id/:floor error:', error);
    return fail(res, 500, 'Server error.');
  }
});

/* ---------------- DELETE BUILDING ---------------- */
router.delete('/api/building/delete/:buildingId', whoami, requireOwner, async (req, res) => {
  try {
    const building = req.building;

    // Counts reported to the client, gathered before the cascade removes them.
    const [nodeCount, floors] = await Promise.all([
      prisma.node.count({ where: { buildingId: building.id } }),
      prisma.floor.findMany({
        where: { buildingId: building.id },
        select: { id: true, mapImageUrl: true },
      }),
    ]);

    // FK cascades replace the manual multi-collection cleanup: floors, nodes,
    // edges, roles, members, invites, logs, emergencies and scan events all go
    // with the building row.
    // D3: incident history outlives the building — archived in the same
    // transaction, before the cascade removes it.
    await prisma.$transaction(async (tx) => {
      await archiveIncidents(tx, { where: { id: building.id }, reason: 'building_deleted' });
      await tx.building.delete({ where: { id: building.id } });
    });
    invalidate(building.id);

    // Best-effort S3/Cloudinary cleanup — data is already gone, assets are
    // just storage cost, so failures are logged and ignored.
    for (const f of floors) await deleteAssetQuietly(f.mapImageUrl, building.id);

    return ok(res, {
      message: 'Building and all related data deleted successfully.',
      extra: {
        DeletedCounts: {
          nodes: nodeCount,
          floors: floors.length,
        },
      },
    });
  } catch (err) {
    console.error('Delete Error:', err);
    return fail(res, 500, 'Server error.');
  }
});

/* ---------------- DELETE FLOOR ---------------- */
router.delete(
  '/api/building/:buildingId/floor/:floorNumber',
  whoami,
  requirePermission(PERMISSIONS.CAN_EDIT_MAP),
  async (req, res) => {
    const floorNum = parseInt(req.params.floorNumber, 10);
    if (Number.isNaN(floorNum) || floorNum < 1) {
      return fail(res, 400, 'Invalid floor number.');
    }

    try {
      // Floor rows have stable identity now — deleting floor 2 no longer
      // renumbers floor 3, so nodes and QR codes on other floors stay valid.
      const floor = await prisma.floor.findUnique({
        where: {
          buildingId_floorNumber: { buildingId: req.building.id, floorNumber: floorNum },
        },
      });

      let nodeCount = 0;
      let floorDeleted = 0;
      if (floor) {
        nodeCount = await prisma.node.count({ where: { floorId: floor.id } });
        await prisma.floor.delete({ where: { id: floor.id } }); // cascades nodes/edges
        floorDeleted = 1;
        await deleteAssetQuietly(floor.mapImageUrl, req.building.id);
        invalidate(req.building.id);
      }

      return ok(res, {
        message: 'Floor and all related data deleted successfully.',
        extra: {
          DeletedCounts: {
            nodes: nodeCount,
            floorMap: floorDeleted,
          },
        },
      });
    } catch (err) {
      console.error('Floor Delete Error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

/* ---------------- DEACTIVATE BUILDING ---------------- */
router.put('/api/building/deactivate/:id', whoami, requireOwner, async (req, res) => {
  try {
    const building = await prisma.building.update({
      where: { id: req.building.id },
      data: { isDeactivated: true },
    });

    if (building.emergencyMode === true) {
      await prisma.log.create({
        data: {
          buildingId: building.id,
          type: 'SYSTEM',
          message: 'Building has been deactivated.',
          isEmergency: true,
        },
      });
    }

    ok(res, { message: 'Building deactivated.' });
  } catch (err) {
    console.error('PUT /api/building/deactivate/:id error:', err);
    fail(res, 200, 'Server error.');
  }
});

// The anonymous /api/building/evacuated and /api/building/emergencyCall
// handlers moved to src/features/emergency/emergency.routes.js, which registers
// both legacy paths as aliases of the new /api/emergency/... endpoints.

export default router;
