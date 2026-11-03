import prisma from '../../../../db/prisma.js';
import { PERMISSIONS } from '../../../../auth/permissions.js';
import { getGraph, invalidate } from '../../../wayfinding/graphCache.js';
import { validateGraph } from '../../../mapEditor/graphValidation.js';
import { defineTool } from '../toolRegistry.js';

/* ============================================================================
   Tools for the Safety Auditor.
   ----------------------------------------------------------------------------
   These invent nothing. validateGraph already produces
   {code, severity, message, nodeIds}, so the model's job is to explain a
   finding the server made, not to notice one itself — which is why this agent
   has almost no hallucination surface and why it ships first.

   Every lookup is scoped by ctx.buildingId. That id comes from
   requireBuildingPermission; a floorId comes from the MODEL, which makes it
   attacker-influenced input and means it can never be trusted on its own.
   ========================================================================= */

/** Cap what reaches the prompt: an owner with a broken graph can have hundreds
 *  of issues, and the first handful are the ones worth fixing first. */
const MAX_ISSUES = 8;
const MAX_FLOORS = 20;

const validate_building = defineTool({
  name: 'validate_building',
  description:
    'Check this building\'s routing graph for problems that would break evacuation routing — missing exits, unreachable areas, orphaned points, floors with no exit. Returns structured issues with a code and severity.',
  permission: PERMISSIONS.CAN_EDIT_MAP,
  parameters: { type: 'object', properties: {} },
  handler: async (ctx) => {
    // The editor writes and the cache invalidation behind them are not
    // transactional with this read, so drop the cached graph first: a stale
    // "your building has no exit" is worse than a slightly slower answer.
    invalidate(ctx.buildingId);
    const graph = await getGraph(ctx.buildingId);
    const report = validateGraph(graph);

    return {
      ok: report.ok,
      issueCount: report.issues.length,
      issues: report.issues.slice(0, MAX_ISSUES).map((issue) => ({
        code: issue.code,
        severity: issue.severity,
        message: issue.message,
        // Ids are for the owner to act on, not for the model to narrate.
        nodeCount: issue.nodeIds?.length ?? 0,
      })),
    };
  },
});

const get_building_overview = defineTool({
  name: 'get_building_overview',
  description:
    'List this building\'s floors with how many routing points and emergency exits each one has.',
  permission: PERMISSIONS.CAN_EDIT_MAP,
  parameters: { type: 'object', properties: {} },
  handler: async (ctx) => {
    const floors = await prisma.floor.findMany({
      where: { buildingId: ctx.buildingId },
      select: { id: true, floorNumber: true, name: true },
      orderBy: { floorNumber: 'asc' },
      take: MAX_FLOORS,
    });

    const counts = await prisma.node.groupBy({
      by: ['floorId', 'type'],
      where: { buildingId: ctx.buildingId },
      _count: { _all: true },
    });

    const tally = new Map();
    for (const row of counts) {
      const entry = tally.get(row.floorId) || { nodeCount: 0, exitCount: 0 };
      entry.nodeCount += row._count._all;
      if (row.type === 'EMERGENCY_EXIT') entry.exitCount += row._count._all;
      tally.set(row.floorId, entry);
    }

    return {
      floors: floors.map((floor) => ({
        floorId: floor.id,
        floorNumber: floor.floorNumber,
        name: floor.name,
        nodeCount: tally.get(floor.id)?.nodeCount ?? 0,
        exitCount: tally.get(floor.id)?.exitCount ?? 0,
      })),
    };
  },
});

const propose_auto_connect = defineTool({
  name: 'propose_auto_connect',
  description:
    'Offer the owner a one-tap action that wires up the walkable connections on a floor. Use it when a floor has routing points that are not connected to each other.',
  permission: PERMISSIONS.CAN_EDIT_MAP,
  // The agent proposes; the owner taps; the existing REST route does the write
  // with its own validation, rate limit and cache invalidation. No agent tool
  // mutates a map.
  sideEffect: 'client',
  parameters: {
    type: 'object',
    properties: { floorId: { type: 'string' } },
    required: ['floorId'],
  },
  handler: async (ctx, args) => {
    const floor = await prisma.floor.findFirst({
      // Scoped by both: the floorId came from the model.
      where: { id: args.floorId, buildingId: ctx.buildingId },
      select: { id: true, floorNumber: true },
    });

    // Deliberately indistinguishable from "this floor does not exist" — a
    // different message would confirm the existence of another tenant's floor.
    if (!floor) return { error: 'That floor was not found in this building.' };

    return {
      action: { name: 'auto_connect_floor', args: { floorId: floor.id } },
      floorNumber: floor.floorNumber,
    };
  },
});

export const auditTools = Object.freeze({
  validate_building,
  get_building_overview,
  propose_auto_connect,
});
