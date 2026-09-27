import express from 'express';
import { ok, fail } from '../../utils/respond.js';
import { isId } from '../../utils/ids.js';
import { publicReadLimiter } from '../../services/rateLimiter.js';
import { getGraph } from '../wayfinding/graphCache.js';
import { findEvacuationRoute } from '../wayfinding/dijkstra.js';
import { assembleRoute } from '../wayfinding/routeAssembler.js';
import { resolveProfile } from '../wayfinding/costModel.js';
import { aiAvailable, chatOnce } from './aiClient.js';

/* ============================================================================
   POST /api/ai/evacuation-brief
   ----------------------------------------------------------------------------
   One grounded sentence for the emergency overlay.

   This is deliberately NOT a chat agent. An evacuating person should not be
   typing, which is why the assistant launcher is hidden while the overlay is
   up — and that judgement is right. What the overlay gets instead is a single
   sentence describing the route Dijkstra already computed.

   The ordering is the whole safety argument: the route is computed FIRST, and
   the model is handed the finished facts. It never queries, never chooses a
   destination, and never sees the graph — so the sentence cannot name an exit
   that the red line on screen does not lead to. If no provider answers, the
   template renders the same facts and nobody notices.

   It is also the cheapest possible AI call: one non-streaming completion, no
   tools, ~60 tokens. During an emergency a building may have hundreds of
   people on this page at once.
   ========================================================================= */

const router = express.Router();

const BRIEF_MAX_TOKENS = 80;

/**
 * Compute the evacuation facts. Pure lookup — no model involved.
 * @returns {Promise<{found: boolean, exitName?: string, exitFloorNumber?: number|null,
 *                    distanceMeters?: number, floorChanges?: number, usesElevator?: boolean,
 *                    accessibleRouteUnavailable?: boolean}>}
 */
export async function buildBriefFacts({ buildingId, nodeId, accessible = false }) {
  if (!isId(buildingId) || !isId(nodeId)) return { found: false };

  const graph = await getGraph(buildingId);
  // Scoped by construction: the graph only ever holds this building's nodes,
  // so a node id from elsewhere simply is not in it.
  if (!graph.nodes.has(nodeId)) return { found: false };

  // B16 fix: this brief is read ALONGSIDE the drawn route on the same
  // overlay, and its own documented contract above says it must never
  // contradict that line. Every other evacuation surface (`/evacuate`, the
  // QR scan route) always searches under the `emergency` profile's
  // visibility and blocking — elevators off-limits unless the building says
  // its cars are evacuation-rated — with `accessible` layered on top as an
  // independent constraint, never a different profile. Searching with no
  // profile at all (the previous behaviour) used pixel weights and never
  // excluded a lift, so this function could — and, on a building with a
  // non-rated lift, did — narrate a route through a door the scan/evacuate
  // surfaces would have refused to offer at all.
  const profile = resolveProfile(graph.routingProfile ?? null, 'emergency');
  const result = findEvacuationRoute(graph, nodeId, { accessible, profile });
  if (!result) return { found: false };

  const profileName = accessible ? 'wheelchair' : 'emergency';
  const route = assembleRoute(graph, result.path, {
    mode: 'EVACUATION',
    accessible,
    accessibleRouteUnavailable: result.accessibleRouteUnavailable,
    profile,
    profileName,
  });
  if (!route) return { found: false };

  const exitNode = graph.nodes.get(result.path[result.path.length - 1]);
  const transitions = route.transitions || [];
  const meters = Math.round(route.totalDistanceMeters ?? 0);

  return {
    found: true,
    exitName: exitNode?.label || null,
    exitFloorNumber: exitNode?.floorNumber ?? null,
    // Omitted rather than zero: an unscaled floor cannot express metres, and
    // "0 m" reads as "you are already there".
    ...(meters > 0 ? { distanceMeters: meters } : {}),
    floorChanges: transitions.length,
    // Now that the search runs under the `emergency` profile, this can only
    // ever be true when the building's lifts are evacuation-rated — the same
    // condition under which /evacuate and the scan route would also route
    // through one. It stays reported (rather than dropped) so the sentence
    // can still say so when it happens.
    usesElevator: transitions.some((transition) => transition.transitType === 'ELEVATOR'),
    accessibleRouteUnavailable: Boolean(route.accessibleRouteUnavailable),
  };
}

const NO_ROUTE = {
  en: 'No exit route could be found from here. Follow the nearest marked exit sign.',
  ka: 'აქედან გასასვლელი მარშრუტი ვერ მოიძებნა. მიჰყევით უახლოეს მონიშნულ გასასვლელ ნიშანს.',
};

/** The deterministic rendering. Always correct, always available. */
export function briefTemplate(facts, locale = 'en') {
  const lang = locale === 'ka' ? 'ka' : 'en';
  if (!facts.found) return NO_ROUTE[lang];

  const exit = facts.exitName || (lang === 'ka' ? 'გასასვლელი' : 'the emergency exit');
  const parts = [];

  if (lang === 'ka') {
    parts.push(`უახლოესი გასასვლელი: ${exit}`);
    if (facts.exitFloorNumber !== null && facts.exitFloorNumber !== undefined) {
      parts.push(`სართული ${facts.exitFloorNumber}`);
    }
    if (facts.distanceMeters) parts.push(`დაახლოებით ${facts.distanceMeters} მ`);
    let text = `${parts.join(', ')}.`;
    if (facts.floorChanges > 0) text += ' მიჰყევით ეკრანზე მონიშნულ წითელ მარშრუტს.';
    return text;
  }

  parts.push(`Nearest exit: ${exit}`);
  if (facts.exitFloorNumber !== null && facts.exitFloorNumber !== undefined) {
    parts.push(`floor ${facts.exitFloorNumber}`);
  }
  if (facts.distanceMeters) parts.push(`about ${facts.distanceMeters} m`);
  let text = `${parts.join(', ')}.`;
  if (facts.floorChanges > 0) text += ' Follow the red route on screen.';
  return text;
}

/** Ask the model to phrase the facts it is handed. Never to find them. */
async function phraseBrief(facts, locale, signal) {
  const system = [
    'You write ONE short sentence for an emergency evacuation overlay.',
    'You are given facts that were already computed. Restate them calmly and plainly.',
    'Never add a fact you were not given: no directions, no landmarks, no floor or exit that is not listed.',
    `Reply ONLY in ${locale === 'ka' ? 'Georgian' : 'English'}. One sentence. No preamble.`,
    'The visitor is following a red route drawn on their screen; never contradict it or give your own turn-by-turn directions.',
  ].join('\n');

  const reply = await chatOnce({
    role: 'chat',
    system,
    messages: [{ role: 'user', content: JSON.stringify(facts) }],
    maxTokens: BRIEF_MAX_TOKENS,
    signal,
  });

  return reply?.trim() || '';
}

router.post('/api/ai/evacuation-brief', publicReadLimiter, async (req, res) => {
  const { buildingId, nodeId, accessible, locale } = req.body || {};
  if (!isId(buildingId)) return fail(res, 400, 'Invalid building id.');

  const lang = locale === 'ka' ? 'ka' : 'en';

  let facts;
  try {
    facts = await buildBriefFacts({
      buildingId,
      nodeId,
      accessible: Boolean(accessible),
    });
  } catch (err) {
    console.error('Evacuation brief routing error:', err?.message);
    facts = { found: false };
  }

  const template = briefTemplate(facts, lang);

  // The template is the answer unless a model improves on it. It is never the
  // other way round: nothing here waits on a provider to produce a sentence.
  if (!aiAvailable()) {
    return ok(res, { data: { ...facts, text: template, fallback: true } });
  }

  const abort = new AbortController();
  req.on('close', () => abort.abort());

  try {
    const phrased = await phraseBrief(facts, lang, abort.signal);
    return ok(res, {
      data: { ...facts, text: phrased || template, fallback: !phrased },
    });
  } catch (err) {
    if (!abort.signal.aborted) console.error('Evacuation brief phrasing failed:', err?.message);
    return ok(res, { data: { ...facts, text: template, fallback: true } });
  }
});

export default router;
