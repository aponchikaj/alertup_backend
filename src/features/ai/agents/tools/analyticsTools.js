import prisma from '../../../../db/prisma.js';
import { PERMISSIONS } from '../../../../auth/permissions.js';
import { defineTool } from '../toolRegistry.js';

/* ============================================================================
   Tools for the Analytics agent.
   ----------------------------------------------------------------------------
   Day buckets are UTC and ISO-keyed, matching /api/dashboard. Two analytics
   surfaces that disagree about when a day starts is its own kind of bug.

   The entrance breakdown only became answerable when ScanEvent grew a nodeId:
   before that a scan row knew the building and the time and nothing else, so
   "which entrance do visitors actually use" had no answer in the data.

   Everything is capped. An owner with a year of traffic must not be able to
   push a hundred rows into a prompt.
   ========================================================================= */

const MAX_DAYS = 90;
const MAX_EMERGENCIES = 20;
const MAX_ENTRANCES = 5;

const clampDays = (days) => Math.min(Math.max(Number(days) || 14, 1), MAX_DAYS);

/** Start of the UTC day, `days - 1` days back — the dashboard's convention. */
function windowStart(days) {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return start;
}

const minutesBetween = (from, to) =>
  from && to ? Math.max(0, Math.round((to.getTime() - from.getTime()) / 60000)) : null;

const get_scan_activity = defineTool({
  name: 'get_scan_activity',
  description:
    'How many QR scans this building had per day over a recent window, and which entrances they happened at.',
  permission: PERMISSIONS.CAN_VIEW_ANALYTICS,
  parameters: {
    type: 'object',
    properties: { days: { type: 'integer' } },
  },
  handler: async (ctx, args) => {
    const days = clampDays(args.days);
    const start = windowStart(days);

    const scans = await prisma.scanEvent.findMany({
      where: { buildingId: ctx.buildingId, scannedAt: { gte: start } },
      select: { scannedAt: true, nodeId: true },
      // Bounded: a very busy building should cost a capped read, not a scan of
      // the whole table, and the shape of the answer is unchanged by the tail.
      take: 5000,
      orderBy: { scannedAt: 'desc' },
    });

    // Pre-seed every day so a quiet day reads as 0 rather than going missing —
    // a gap in a series is ambiguous, a zero is not.
    const buckets = new Map();
    for (let i = 0; i < days; i += 1) {
      const day = new Date(start);
      day.setUTCDate(start.getUTCDate() + i);
      buckets.set(day.toISOString().slice(0, 10), 0);
    }

    const byNode = new Map();
    for (const scan of scans) {
      const key = scan.scannedAt.toISOString().slice(0, 10);
      if (buckets.has(key)) buckets.set(key, buckets.get(key) + 1);
      if (scan.nodeId) byNode.set(scan.nodeId, (byNode.get(scan.nodeId) || 0) + 1);
    }

    const topNodeIds = [...byNode.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_ENTRANCES);

    const nodes = topNodeIds.length
      ? await prisma.node.findMany({
          // Scoped even though these ids came from this building's own rows:
          // the query shape is the tenant boundary everywhere else too.
          where: { id: { in: topNodeIds.map(([id]) => id) }, buildingId: ctx.buildingId },
          select: { id: true, label: true, floor: { select: { floorNumber: true } } },
        })
      : [];
    const labels = new Map(nodes.map((node) => [node.id, node]));

    return {
      days,
      total: scans.length,
      daily: [...buckets.entries()].map(([date, count]) => ({ date, count })),
      topEntrances: topNodeIds.map(([nodeId, count]) => ({
        nodeId,
        label: labels.get(nodeId)?.label || 'an unlabelled point',
        floorNumber: labels.get(nodeId)?.floor?.floorNumber ?? null,
        count,
      })),
    };
  },
});

const list_emergencies = defineTool({
  name: 'list_emergencies',
  description:
    'The emergencies and drills recorded for this building in a recent window, with how many people scanned, evacuated and called emergency services.',
  permission: PERMISSIONS.CAN_VIEW_ANALYTICS,
  parameters: {
    type: 'object',
    properties: { days: { type: 'integer' } },
  },
  handler: async (ctx, args) => {
    const days = clampDays(args.days);

    const events = await prisma.emergencyEvent.findMany({
      where: { buildingId: ctx.buildingId, startedAt: { gte: windowStart(days) } },
      orderBy: { startedAt: 'desc' },
      take: MAX_EMERGENCIES,
      select: {
        id: true,
        status: true,
        trigger: true,
        startedAt: true,
        endedAt: true,
        scanned: true,
        evacuated: true,
        calledEmergency: true,
      },
    });

    return {
      days,
      count: events.length,
      emergencies: events.map((event) => ({
        emergencyId: event.id,
        status: event.status,
        trigger: event.trigger,
        startedAt: event.startedAt.toISOString(),
        // Null while it is still running, rather than a duration measured
        // against "now" that would change every time it is asked.
        durationMinutes: minutesBetween(event.startedAt, event.endedAt),
        scanned: event.scanned,
        evacuated: event.evacuated,
        calledEmergency: event.calledEmergency,
      })),
    };
  },
});

const get_emergency_report = defineTool({
  name: 'get_emergency_report',
  description:
    'What happened during one specific emergency: its counters and a tally of what was logged while it ran.',
  permission: PERMISSIONS.CAN_VIEW_ANALYTICS,
  parameters: {
    type: 'object',
    properties: { emergencyId: { type: 'string' } },
    required: ['emergencyId'],
  },
  handler: async (ctx, args) => {
    const event = await prisma.emergencyEvent.findFirst({
      // Scoped: the id came from the model.
      where: { id: args.emergencyId, buildingId: ctx.buildingId },
      select: {
        id: true,
        status: true,
        trigger: true,
        message: true,
        startedAt: true,
        endedAt: true,
        scanned: true,
        evacuated: true,
        calledEmergency: true,
      },
    });

    // Same answer for "not yours" as for "does not exist": a different message
    // would confirm that another tenant's emergency is real.
    if (!event) return { found: false };

    const grouped = await prisma.log.groupBy({
      by: ['type'],
      where: {
        buildingId: ctx.buildingId,
        isEmergency: true,
        createdAt: {
          gte: event.startedAt,
          ...(event.endedAt ? { lte: event.endedAt } : {}),
        },
      },
      _count: { _all: true },
    });

    const logCounts = {};
    for (const row of grouped) logCounts[row.type] = row._count._all;

    return {
      found: true,
      emergencyId: event.id,
      status: event.status,
      trigger: event.trigger,
      message: event.message,
      startedAt: event.startedAt.toISOString(),
      durationMinutes: minutesBetween(event.startedAt, event.endedAt),
      scanned: event.scanned,
      evacuated: event.evacuated,
      calledEmergency: event.calledEmergency,
      logCounts,
    };
  },
});

export const analyticsTools = Object.freeze({
  get_scan_activity,
  list_emergencies,
  get_emergency_report,
});
