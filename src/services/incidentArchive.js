/**
 * D3 (founder decision 2026-11-03): incident history outlives the building.
 *
 * Call inside the SAME transaction as a building delete, before it runs: the
 * delete cascades EmergencyEvent, Log and AiConversation rows away, and this
 * copies what an incident review needs into IncidentArchive (no foreign keys,
 * so it survives both the building and its owner).
 *
 * Per building:
 *   - one INCIDENT row per EmergencyEvent: the event, every log written while
 *     it was open (createdAt within [startedAt, endedAt ?? now]), and the AI
 *     conversations opened during it, with their messages;
 *   - one AUDIT row with the building's accountability log rows (those that
 *     name an entity), when there are any.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {{ where: object, reason: 'building_deleted'|'account_deleted'|'admin_deleted' }} args
 *   `where` selects the buildings about to be deleted (a Building where-input).
 * @returns {Promise<number>} rows written
 */
export async function archiveIncidents(tx, { where, reason }) {
  const buildings = await tx.building.findMany({
    where,
    select: { id: true, name: true, ownerId: true },
  });
  let written = 0;

  for (const building of buildings) {
    const base = { buildingId: building.id, buildingName: building.name, ownerId: building.ownerId, reason };

    const events = await tx.emergencyEvent.findMany({
      where: { buildingId: building.id },
      orderBy: { startedAt: 'asc' },
    });
    for (const event of events) {
      const [logs, aiConversations] = await Promise.all([
        tx.log.findMany({
          where: {
            buildingId: building.id,
            createdAt: { gte: event.startedAt, lte: event.endedAt ?? new Date() },
          },
          orderBy: { createdAt: 'asc' },
        }),
        tx.aiConversation.findMany({
          where: { buildingId: building.id, emergencyId: event.id },
          include: { messages: { orderBy: { createdAt: 'asc' } } },
        }),
      ]);
      await tx.incidentArchive.create({
        data: {
          ...base,
          kind: 'INCIDENT',
          emergencyId: event.id,
          startedAt: event.startedAt,
          endedAt: event.endedAt,
          snapshot: toJson({ event, logs, aiConversations }),
        },
      });
      written += 1;
    }

    const auditLogs = await tx.log.findMany({
      where: { buildingId: building.id, entity: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
    if (auditLogs.length > 0) {
      await tx.incidentArchive.create({
        data: { ...base, kind: 'AUDIT', snapshot: toJson({ logs: auditLogs }) },
      });
      written += 1;
    }
  }
  return written;
}

/** Dates to ISO strings so the snapshot is plain JSON. */
const toJson = (value) => JSON.parse(JSON.stringify(value));
