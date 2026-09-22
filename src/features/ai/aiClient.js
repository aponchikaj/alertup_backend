import config from '../../config/index.js';
import * as gemini from './geminiClient.js';
import * as groq from './groqClient.js';

/* ============================================================================
   Provider router — Gemini first, Groq as the fallback.
   ----------------------------------------------------------------------------
   Routes import from here, never from a provider directly, so swapping or
   reordering providers is a config change rather than an edit to every call
   site.

   Why a fallback at all: Gemini's free tier has per-minute and per-day request
   caps. Hitting one returns 429, and for this app that would mean the emergency
   concierge going dark exactly when a building is busy. Groq then answers
   instead and the visitor never learns a provider changed.
   ========================================================================= */

const PROVIDERS = { gemini, groq };

/** Model overrides are provider-specific, so they travel per provider. */
const MODELS = {
  gemini: {
    chat: () => config.gemini.model,
    design: () => config.gemini.designModel,
    vision: () => config.gemini.visionModel,
  },
  groq: {
    chat: () => config.groq.model,
    design: () => config.groq.designModel,
    vision: () => config.groq.visionModel,
  },
};

/** Provider order: the configured primary, then any other usable one. */
function chain() {
  const preferred = config.ai.provider;
  const order = [preferred, ...Object.keys(PROVIDERS).filter((n) => n !== preferred)];
  return order.filter((name) => PROVIDERS[name].aiAvailable());
}

/** True when at least one provider holds a key and AI is not disabled. */
export function aiAvailable() {
  return chain().length > 0;
}

/** Which provider would answer right now — for logging and the debug route. */
export function activeProvider() {
  return chain()[0] || null;
}

/**
 * Resolve a logical model name ('chat' | 'design' | 'vision') for a provider.
 * Returns undefined when that provider has none configured, which lets the
 * client fall back to its own default.
 */
export function modelFor(provider, role = 'chat') {
  return MODELS[provider]?.[role]?.() || undefined;
}

/** A failure worth trying the next provider for. */
function isRetryable(error) {
  // A caller-cancelled request is not a provider failure — the visitor closed
  // the tab or typed again. Retrying would burn the fallback's quota for a
  // response nobody is waiting for.
  if (error?.name === 'AbortError') return false;

  const status = error?.status ?? error?.response?.status;
  if (status === 429) return true; // rate limited — the whole point of this
  if (typeof status === 'number' && status >= 500) return true;
  if (status === 401 || status === 403) return true; // bad/expired key

  // Network-level failures surface without a status.
  return status === undefined;
}

/**
 * Streaming chat across the provider chain.
 *
 * Fallback only happens BEFORE the first token. Once a delta has reached the
 * client, the response is already partly rendered on screen — restarting on
 * another provider would append a second, differently-worded answer to the
 * first half. A mid-stream failure therefore ends the stream and the caller's
 * existing error handling takes over.
 *
 * @param {{system: string, messages: Array, signal?: AbortSignal,
 *          maxTokens?: number, role?: 'chat'|'design'}} params
 */
export async function* streamChat({ role = 'chat', ...params }) {
  const providers = chain();
  if (!providers.length) throw new Error('No AI provider is configured');

  let lastError = null;

  for (const name of providers) {
    let yielded = false;
    try {
      const model = params.model || modelFor(name, role);
      for await (const delta of PROVIDERS[name].streamChat({ ...params, model })) {
        yielded = true;
        yield delta;
      }
      return;
    } catch (error) {
      lastError = error;
      if (yielded || !isRetryable(error)) throw error;
      console.warn(`[ai] ${name} stream failed before first token, trying next:`, error?.message);
    }
  }

  throw lastError ?? new Error('Every AI provider failed');
}

/** One-shot completion across the provider chain. Safe to retry outright. */
export async function chatOnce({ role = 'chat', ...params }) {
  const providers = chain();
  if (!providers.length) throw new Error('No AI provider is configured');

  let lastError = null;

  for (const name of providers) {
    try {
      const model = params.model || modelFor(name, role);
      if (role === 'vision' && !model) continue; // provider has no vision model
      return await PROVIDERS[name].chatOnce({ ...params, model });
    } catch (error) {
      lastError = error;
      if (!isRetryable(error)) throw error;
      console.warn(`[ai] ${name} chatOnce failed, trying next:`, error?.message);
    }
  }

  throw lastError ?? new Error('Every AI provider failed');
}

/** True when some provider in the chain can read images. */
export function visionAvailable() {
  return chain().some((name) => Boolean(modelFor(name, 'vision')));
}

export { FIRST_TOKEN_TIMEOUT_MS } from './groqClient.js';
