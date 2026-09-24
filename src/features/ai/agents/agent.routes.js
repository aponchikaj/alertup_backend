import express from 'express';
import prisma from '../../../db/prisma.js';
import { fail } from '../../../utils/respond.js';
import { isId } from '../../../utils/ids.js';
import whoami from '../../../middlewares/whoami.js';
import { requirePermission } from '../../../middlewares/requireBuildingPermission.js';
import { aiChatLimiter, aiDailyLimiter } from '../../../services/rateLimiter.js';
import { checkAiBudget } from '../../../services/aiBudget.js';
import { initSse, sendData } from '../../realtime/sseHelpers.js';
import { aiAvailable, activeProvider } from '../aiClient.js';
import { validateChatBody } from '../aiGuards.js';
import { fenceUserContent } from '../promptBuilder.js';
import { getAgent, TOOL_REGISTRY } from './registry.js';
import { runAgent } from './runtime.js';

/* ============================================================================
   POST /api/ai/agent/:agentId
   ----------------------------------------------------------------------------
   One route, many agents. The agent spec decides which tools exist and which
   permission is required; nothing about a particular agent is branched on here.

   The frame contract is a SUPERSET of the one aiApi.ts already speaks —
   {delta} / {done} / {fallback} — plus {tool} and {action}. New surfaces get a
   new client module rather than teaching the deployed parser to ignore frames
   it predates, so an old build can never be handed a frame it will mis-render.
   ========================================================================= */

const router = express.Router();

/** Resolved first: which agent it is decides whether auth applies at all. */
function resolveAgent(req, res, next) {
  const agent = getAgent(req.params.agentId);
  if (!agent) return fail(res, 404, 'Unknown assistant.');
  req.agent = agent;
  next();
}

/**
 * Owner-facing agents require a session. The visitor Wayfinder does not, and
 * must not: the scan page has no login, and anyone physically in the building
 * has to be able to ask where the exit is.
 */
function authForAgent(req, res, next) {
  if (req.agent.requiresAuth) return whoami(req, res, next);
  req.user = null;
  return next();
}

/**
 * Attach req.building. A permissioned agent goes through the same guard every
 * other building route uses; an anonymous one gets the public read the scan
 * page already performs, with an explicitly empty permission set so no guarded
 * tool can ever be reachable from it.
 */
async function buildingForAgent(req, res, next) {
  if (req.agent.requiredPermission) {
    return requirePermission(req.agent.requiredPermission)(req, res, next);
  }

  const buildingId = req.body?.buildingId;
  if (!isId(buildingId)) return fail(res, 400, 'Invalid building id.');

  const building = await prisma.building.findUnique({
    where: { id: buildingId },
    select: {
      id: true,
      name: true,
      emergencyMode: true,
      emergencyMessage: true,
      isDeactivated: true,
    },
  });
  if (!building || building.isDeactivated) return fail(res, 404, 'Building not found.');

  req.building = building;
  req.buildingPermissions = [];
  req.isOwner = false;
  return next();
}

const UNAVAILABLE = {
  en: 'The assistant is unavailable right now. You can still run the validation check from the panel.',
  ka: 'ასისტენტი ამჟამად მიუწვდომელია. შემოწმება პანელიდან კვლავ ხელმისაწვდომია.',
};

const BUDGET_SPENT = {
  en: "This building has reached today's assistant limit. The validation check still works.",
  ka: 'ამ შენობამ დღევანდელი ლიმიტი ამოწურა. შემოწმება კვლავ მუშაობს.',
};

router.post(
  '/api/ai/agent/:agentId',
  resolveAgent,
  authForAgent,
  buildingForAgent,
  aiChatLimiter,
  aiDailyLimiter,
  async (req, res) => {
    // Relaxed against the anonymous concierge caps: this caller is
    // authenticated and permissioned, and issue lists run long.
    const parsed = req.agent.requiresAuth
      ? validateChatBody(req.body, { maxMessageChars: 2000, maxTotalChars: 8000 })
      : validateChatBody(req.body);
    if (!parsed.ok) return fail(res, 422, parsed.error);

    const { messages, locale } = parsed;
    const building = req.building;
    const agent = req.agent;

    const budget = await checkAiBudget({ buildingId: building.id, userId: req.user?.id ?? null });
    if (!budget.ok) return fail(res, 429, BUDGET_SPENT[locale] || BUDGET_SPENT.en);

    // An assistant turn taken while a building is being evacuated is an audit
    // record, not a transcript — the sweeper keys retention on this id.
    const activeEmergency = await prisma.emergencyEvent.findFirst({
      where: { buildingId: building.id, status: 'ACTIVE' },
      select: { id: true },
    });

    // Where the visitor scanned in. Validated here once: it is stored on the
    // conversation, used to build the prompt, and handed to the graph tools.
    const scanNodeId = isId(req.body?.nodeId) ? req.body.nodeId : null;

    const conversation = await prisma.aiConversation.create({
      data: {
        agentId: agent.id,
        buildingId: building.id,
        nodeId: scanNodeId,
        userId: req.user?.id ?? null,
        emergencyId: activeEmergency?.id ?? null,
        locale,
      },
    });

    const lastTurn = messages[messages.length - 1];
    await prisma.aiMessage.create({
      data: { conversationId: conversation.id, role: 'user', content: lastTurn.content },
    });

    initSse(res, { retryMs: 0 });

    const fallbackText = UNAVAILABLE[locale] || UNAVAILABLE.en;
    if (!aiAvailable()) {
      sendData(res, { delta: fallbackText, fallback: true });
      sendData(res, { done: true });
      await prisma.aiMessage.create({
        data: {
          conversationId: conversation.id,
          role: 'assistant',
          content: fallbackText,
          fallback: true,
        },
      });
      return res.end();
    }

    const abort = new AbortController();
    req.on('close', () => abort.abort());

    // Best-effort and scoped by building: a stale or forged nodeId must
    // degrade the prompt, never fail the request or reach another building.
    let position = { floorNumber: null, floorName: null, nodeLabel: null };
    if (scanNodeId) {
      const node = await prisma.node.findFirst({
        where: { id: scanNodeId, buildingId: building.id },
        select: { label: true, floor: { select: { floorNumber: true, name: true } } },
      });
      if (node) {
        position = {
          floorNumber: node.floor?.floorNumber ?? null,
          floorName: node.floor?.name ?? null,
          nodeLabel: node.label ?? null,
        };
      }
    }

    const ctx = {
      ...position,
      user: req.user,
      building,
      buildingId: building.id,
      buildingName: building.name,
      permissions: req.buildingPermissions,
      isOwner: req.isOwner,
      locale,
      // Where the visitor scanned in. Null for the owner-facing agents, which
      // have no position, and the graph tools report that honestly.
      nodeId: scanNodeId,
      emergencyActive: Boolean(building.emergencyMode),
      emergencyMessage: building.emergencyMode ? building.emergencyMessage : null,
      signal: abort.signal,
    };

    // Only the visitor's own turns are fenced as untrusted; tool results carry
    // their own fence, applied in toolRegistry before they ever reach a prompt.
    const fenced = messages.map((message) =>
      message.role === 'user'
        ? { role: 'user', content: fenceUserContent(message.content) }
        : message
    );

    let answer = '';
    const toolRows = [];

    try {
      for await (const event of runAgent({
        agent,
        ctx,
        messages: fenced,
        registry: TOOL_REGISTRY,
        signal: abort.signal,
      })) {
        if (event.type === 'delta') {
          answer += event.text;
          sendData(res, { delta: event.text });
        } else if (event.type === 'tool') {
          toolRows.push({ name: event.name, ok: event.ok });
          sendData(res, { tool: { name: event.name, ok: event.ok } });
        } else if (event.type === 'action') {
          sendData(res, { action: event.action });
        }
      }

      if (!answer) {
        answer = fallbackText;
        sendData(res, { delta: fallbackText, fallback: true });
      }
      sendData(res, { done: true });
    } catch (err) {
      if (!abort.signal.aborted) {
        console.error('AI agent error:', err?.message);
        try {
          answer = answer || fallbackText;
          sendData(res, { delta: fallbackText, fallback: true });
          sendData(res, { done: true });
        } catch {
          // stream already gone
        }
      }
    }

    // Persisted after the fact rather than per-delta: an audit record wants the
    // finished answer, and one write beats one per token.
    try {
      await prisma.aiMessage.createMany({
        data: [
          ...toolRows.map((row) => ({
            conversationId: conversation.id,
            role: 'tool',
            content: '',
            toolName: row.name,
            toolOk: row.ok,
          })),
          {
            conversationId: conversation.id,
            role: 'assistant',
            content: answer,
            provider: activeProvider(),
          },
        ],
      });
    } catch (err) {
      console.error('AI transcript write failed:', err?.message);
    }

    res.end();
  }
);

export default router;
