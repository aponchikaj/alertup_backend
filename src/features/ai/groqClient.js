import Groq from 'groq-sdk';
import config from '../../config/index.js';

// Thin wrapper around groq-sdk: one streaming entry point with a first-token
// timeout and caller-controlled abort, plus a one-shot completion used for
// vision analysis of uploaded plan images. The SDK handles SSE chunk parsing
// and 429/5xx retries.

let client = null;
function groq() {
  if (!client) {
    client = new Groq({ apiKey: config.groq.apiKey });
  }
  return client;
}

export const FIRST_TOKEN_TIMEOUT_MS = 10000;

/**
 * @param {{system: string, messages: Array<{role, content}>, signal?: AbortSignal,
 *          maxTokens?: number, model?: string}} params — maxTokens/model
 *          override the configured defaults; the visitor concierge stays terse
 *          (default ~300) while the floor designer needs room for a whole
 *          drawing and may run a stronger model.
 * @returns {AsyncGenerator<string>} text deltas
 */
export async function* streamChat({ system, messages, signal, maxTokens, model }) {
  const stream = await groq().chat.completions.create(
    {
      model: model || config.groq.model,
      max_tokens: maxTokens || config.groq.maxTokens,
      temperature: 0.3,
      stream: true,
      messages: [{ role: 'system', content: system }, ...messages],
    },
    { signal, timeout: FIRST_TOKEN_TIMEOUT_MS }
  );

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) yield delta;
  }
}

/**
 * One-shot, non-streaming completion. Content may use the OpenAI-style parts
 * format ([{type:'text'},{type:'image_url'}]) for multimodal models — this is
 * how the editor assistant reads an uploaded floor-plan image.
 */
export async function chatOnce({ system, messages, model, maxTokens = 800, signal }) {
  const completion = await groq().chat.completions.create(
    {
      model: model || config.groq.model,
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    },
    { signal, timeout: 20000 }
  );
  return completion.choices?.[0]?.message?.content || '';
}

export function aiAvailable() {
  return Boolean(config.groq.apiKey) && !config.groq.disabled;
}
