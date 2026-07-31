import Groq from 'groq-sdk';
import config from '../../config/index.js';

// Thin wrapper around groq-sdk: one streaming entry point with a first-token
// timeout and caller-controlled abort. The SDK handles SSE chunk parsing and
// 429/5xx retries.

let client = null;
function groq() {
  if (!client) {
    client = new Groq({ apiKey: config.groq.apiKey });
  }
  return client;
}

export const FIRST_TOKEN_TIMEOUT_MS = 10000;

/**
 * @param {{system: string, messages: Array<{role, content}>, signal?: AbortSignal}} params
 * @returns {AsyncGenerator<string>} text deltas
 */
export async function* streamChat({ system, messages, signal }) {
  const stream = await groq().chat.completions.create(
    {
      model: config.groq.model,
      max_tokens: config.groq.maxTokens,
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

export function aiAvailable() {
  return Boolean(config.groq.apiKey) && !config.groq.disabled;
}
