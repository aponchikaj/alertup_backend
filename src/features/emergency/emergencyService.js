import prisma from '../../db/prisma.js';
import { publish } from '../realtime/broadcaster.js';
import { writeAudit } from '../../services/audit.js';

// Explicit, idempotent emergency transitions. Replaces the old $not-toggle,
// which could flip the wrong way when two admins raced.

export async function getStatus(buildingId) {
  const building = await prisma.building.findUnique({
    where: { id: buildingId },
    select: { id: true, emergencyMode: true, emergencyMessage: true },
  });
  if (!building) return null;

  let event = null;
  if (building.emergencyMode) {
    event = await prisma.emergencyEvent.findFirst({
      where: { buildingId, status: 'ACTIVE' },
      orderBy: { startedAt: 'desc' },
    });
  }

  return {
    isEmergency: building.emergencyMode,
    message: building.emergencyMode ? building.emergencyMessage : null,
    emergencyId: event?.id || null,
    startedAt: event?.startedAt || null,
    counters: event
      ? {
          scanned: event.scanned,
          evacuated: event.evacuated,
          calledEmergency: event.calledEmergency,
        }
      : null,
  };
}

/**
 * @param {string} buildingId
 * @param {object} [options]
 * @param {string|null} [options.message]
 * @param {string|null} [options.userId]
 * @param {string} [options.trigger]
 * @param {'USER'|'SYSTEM'|'INTEGRATION'} [options.actorType] - defaults to
 *   USER when `userId` is given, SYSTEM otherwise (e.g. an automated trigger
 *   with no human behind it).
 * @returns {{alreadyActive: boolean, event}} — never throws for "already on".
 */
export async function triggerEmergency(
  buildingId,
  { message = null, userId = null, trigger = 'ADMIN', actorType = userId ? 'USER' : 'SYSTEM' } = {}
) {
  const result = await prisma.$transaction(async (tx) => {
    const flipped = await tx.building.updateMany({
      where: { id: buildingId, emergencyMode: false },
      data: {
        emergencyMode: true,
        ...(message !== null ? { emergencyMessage: message } : {}),
      },
    });

    if (flipped.count === 0) {
      // Already active — update the message if a new one was provided.
      // entityId is known up front (the row already exists), so the read is
      // moved ahead of the writes: the audit INSERT goes in FIRST, before
      // either update, which is what makes a rollback of this branch provable
      // rather than merely "no orphan row because we never got that far".
      const existing = await tx.emergencyEvent.findFirst({
        where: { buildingId, status: 'ACTIVE' },
        orderBy: { startedAt: 'desc' },
      });
      // Only an actual change (a new message) is worth an accountability row
      // — a re-tap of an already-active trigger changes nothing.
      if (message !== null) {
        if (existing) {
          await writeAudit(tx, {
            buildingId,
            actorUserId: userId,
            actorType,
            entity: 'EmergencyEvent',
            entityId: existing.id,
            action: 'trigger',
            payload: { message, trigger, alreadyActive: true },
          });
        }
        await tx.building.update({
          where: { id: buildingId },
          data: { emergencyMessage: message },
        });
        await tx.emergencyEvent.updateMany({
          where: { buildingId, status: 'ACTIVE' },
          data: { message },
        });
      }
      // Re-read after the update rather than returning `existing` (fetched
      // BEFORE it, to get entityId for the audit-first write above): a caller
      // of this function reasonably expects `.event` to reflect the emergency
      // as it stands after this call, not as it stood before — and here that
      // field is the message shown to people being told to evacuate. Only
      // re-fetch when something could actually have changed; otherwise reuse
      // the read already in hand.
      const current =
        message !== null && existing
          ? await tx.emergencyEvent.findUnique({ where: { id: existing.id } })
          : existing;
      return { alreadyActive: true, event: current };
    }

    const building = await tx.building.findUnique({
      where: { id: buildingId },
      select: { emergencyMessage: true },
    });
    const event = await tx.emergencyEvent.create({
      data: {
        buildingId,
        trigger,
        triggeredById: userId,
        message: message ?? building?.emergencyMessage ?? null,
      },
    });
    await tx.log.create({
      data: {
        buildingId,
        type: 'EMERGENCY',
        isEmergency: true,
        message: 'Emergency mode activated.',
      },
    });
    await writeAudit(tx, {
      buildingId,
      actorUserId: userId,
      actorType,
      entity: 'EmergencyEvent',
      entityId: event.id,
      action: 'trigger',
      payload: { message: event.message, trigger },
    });
    return { alreadyActive: false, event };
  });

  if (!result.alreadyActive) {
    publish(buildingId, 'emergency_started', {
      emergencyId: result.event.id,
      message: result.event.message,
      startedAt: result.event.startedAt,
    });
    publish(buildingId, 'log_appended', {
      message: 'Emergency mode activated.',
      type: 'EMERGENCY',
      createdAt: new Date().toISOString(),
    });
  } else if (message !== null && result.event) {
    publish(buildingId, 'emergency_started', {
      emergencyId: result.event.id,
      message,
      startedAt: result.event.startedAt,
    });
  }

  return result;
}

/**
 * @param {string} buildingId
 * @param {object} [options]
 * @param {string|null} [options.userId]
 * @param {'USER'|'SYSTEM'|'INTEGRATION'} [options.actorType]
 */
export async function resolveEmergency(
  buildingId,
  { userId = null, actorType = userId ? 'USER' : 'SYSTEM' } = {}
) {
  const result = await prisma.$transaction(async (tx) => {
    const flipped = await tx.building.updateMany({
      where: { id: buildingId, emergencyMode: true },
      data: { emergencyMode: false },
    });
    if (flipped.count === 0) return { alreadyResolved: true };

    // Read before the updateMany below flips it out of ACTIVE — the audit
    // row needs the event's id, and "ACTIVE" will match nothing once it isn't.
    const event = await tx.emergencyEvent.findFirst({
      where: { buildingId, status: 'ACTIVE' },
      orderBy: { startedAt: 'desc' },
    });

    // Audit first, ahead of the remaining writes — entityId is already known
    // from the read above, so there's nothing to gain by writing it last.
    if (event) {
      await writeAudit(tx, {
        buildingId,
        actorUserId: userId,
        actorType,
        entity: 'EmergencyEvent',
        entityId: event.id,
        action: 'resolve',
        payload: {},
      });
    }

    // updateMany deliberately: closes any stranded duplicates too.
    await tx.emergencyEvent.updateMany({
      where: { buildingId, status: 'ACTIVE' },
      data: { status: 'RESOLVED', endedAt: new Date() },
    });
    await tx.log.create({
      data: {
        buildingId,
        type: 'EMERGENCY',
        isEmergency: true,
        message: 'Emergency mode deactivated.',
      },
    });
    return { alreadyResolved: false };
  });

  if (!result.alreadyResolved) {
    publish(buildingId, 'emergency_ended', { endedAt: new Date().toISOString() });
  }
  return result;
}

const COUNTER_FIELDS = {
  evacuated: 'evacuated',
  called: 'calledEmergency',
  scanned: 'scanned',
};

const ACTION_LOGS = {
  evacuated: { type: 'EVACUATED', message: 'An occupant reported themselves evacuated.' },
  called: { type: 'REPORT', message: 'An occupant called emergency services.' },
  scanned: { type: 'SCAN', message: 'A QR code was scanned during the emergency.' },
};

/**
 * Anonymous occupant actions during an active emergency. Counters accrue on
 * the open event row; each action also lands in the live log feed.
 *
 * These are NOT accountability audit rows — the actor is an anonymous
 * occupant, not someone accountable for a change — so they stay
 * `isEmergency: true` and are exactly what `POST
 * /api/administration/logs/clear/:id` clears. `message`/`nodeId` let a caller
 * (a QR scan, say) enrich the default text and tag the log to the point that
 * was scanned, without turning it into an audit row.
 *
 * @param {string} buildingId
 * @param {'evacuated'|'called'|'scanned'} action
 * @param {object} [options]
 * @param {string} [options.message] - overrides the default log text.
 * @param {string} [options.nodeId] - the node this action is about, if any.
 */
export async function recordAction(buildingId, action, { message, nodeId } = {}) {
  const field = COUNTER_FIELDS[action];
  if (!field) throw new Error(`Unknown emergency action: ${action}`);

  const logSpec = ACTION_LOGS[action];
  const logMessage = message || logSpec.message;
  const [updated] = await prisma.$transaction([
    prisma.emergencyEvent.updateMany({
      where: { buildingId, status: 'ACTIVE' },
      data: { [field]: { increment: 1 } },
    }),
    prisma.log.create({
      data: {
        buildingId,
        type: logSpec.type,
        isEmergency: true,
        message: logMessage,
        ...(nodeId ? { entity: 'Node', entityId: nodeId } : {}),
      },
    }),
  ]);

  publish(buildingId, 'log_appended', {
    message: logMessage,
    type: logSpec.type,
    createdAt: new Date().toISOString(),
  });
  if (updated.count > 0) {
    const event = await prisma.emergencyEvent.findFirst({
      where: { buildingId, status: 'ACTIVE' },
      select: { scanned: true, evacuated: true, calledEmergency: true },
    });
    if (event) publish(buildingId, 'counters_updated', event);
  }
}
