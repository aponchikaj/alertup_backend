import prisma from '../../db/prisma.js';
import { publish } from '../realtime/broadcaster.js';

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
 * @returns {{alreadyActive: boolean, event}} — never throws for "already on".
 */
export async function triggerEmergency(buildingId, { message = null, userId = null, trigger = 'ADMIN' } = {}) {
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
      if (message !== null) {
        await tx.building.update({
          where: { id: buildingId },
          data: { emergencyMessage: message },
        });
        await tx.emergencyEvent.updateMany({
          where: { buildingId, status: 'ACTIVE' },
          data: { message },
        });
      }
      const existing = await tx.emergencyEvent.findFirst({
        where: { buildingId, status: 'ACTIVE' },
        orderBy: { startedAt: 'desc' },
      });
      return { alreadyActive: true, event: existing };
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

export async function resolveEmergency(buildingId) {
  const result = await prisma.$transaction(async (tx) => {
    const flipped = await tx.building.updateMany({
      where: { id: buildingId, emergencyMode: true },
      data: { emergencyMode: false },
    });
    if (flipped.count === 0) return { alreadyResolved: true };

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
 */
export async function recordAction(buildingId, action) {
  const field = COUNTER_FIELDS[action];
  if (!field) throw new Error(`Unknown emergency action: ${action}`);

  const logSpec = ACTION_LOGS[action];
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
        message: logSpec.message,
      },
    }),
  ]);

  publish(buildingId, 'log_appended', {
    message: logSpec.message,
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
