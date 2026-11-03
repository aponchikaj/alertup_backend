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
  return Boolean(config.groq.apiKey) && !config.ai.disabled;
}

/* ----------------------------------------------------------------------------
   Tool calling, OpenAI dialect. Same return shape as the Gemini adapter so the
   runtime never learns which provider answered.
   -------------------------------------------------------------------------- */

/** Models occasionally emit arguments that are not valid JSON. An unparseable
 *  call becomes an empty argument object, which the tool's own validator then
 *  rejects with a message the model can act on. */
const parseArgs = (raw) => {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

/**
 * @returns {Promise<{text: string, toolCalls: Array<{id, name, args}>}>}
 */
export async function callWithTools({
  system,
  messages,
  tools = [],
  model,
  maxTokens = 800,
  signal,
}) {
  const completion = await groq().chat.completions.create(
    {
      model: model || config.groq.model,
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
      ...(tools.length
        ? {
            tools: tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
            tool_choice: 'auto',
          }
        : {}),
    },
    { signal, timeout: 20000 }
  );

  const message = completion.choices?.[0]?.message;
  return {
    text: message?.content || '',
    toolCalls: (message?.tool_calls || []).map((call, i) => ({
      id: call.id || `call_${i}`,
      name: call.function?.name,
      args: parseArgs(call.function?.arguments),
    })),
  };
}
