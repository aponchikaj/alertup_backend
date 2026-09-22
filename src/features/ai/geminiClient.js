import { GoogleGenAI } from '@google/genai';
import config from '../../config/index.js';

/* ============================================================================
   Gemini client — same surface as groqClient.js on purpose.
   ----------------------------------------------------------------------------
   streamChat / chatOnce / aiAvailable are interchangeable between the two, so
   aiClient.js can pick a provider per call and fall back without any route
   knowing which one answered.

   Callers speak the OpenAI-shaped message format the Groq client established
   (role + string-or-parts content). Translating here rather than at the call
   sites keeps that one dialect across the codebase.
   ========================================================================= */

let client = null;
function gemini() {
  if (!client) {
    client = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  }
  return client;
}

export const FIRST_TOKEN_TIMEOUT_MS = 10000;

/** Cap on a fetched underlay image. Gemini accepts more, but a 20MB floor plan
 *  base64-encoded is 27MB of request body for no extra detail. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Pull a remote image into the inline base64 part Gemini wants.
 *
 * Groq took an `image_url` and fetched it itself; Gemini has no equivalent, so
 * the fetch happens here. Data URIs are decoded without a network round trip.
 */
async function toInlineImage(url, signal) {
  const dataUri = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (dataUri) {
    return { inlineData: { mimeType: dataUri[1], data: dataUri[2] } };
  }

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image too large: ${buf.byteLength} bytes`);
  }

  const mimeType = res.headers.get('content-type')?.split(';')[0] || 'image/png';
  return { inlineData: { mimeType, data: buf.toString('base64') } };
}

/** One OpenAI-shaped message -> one Gemini Content. */
async function toContent(message, signal) {
  // Gemini names the assistant turn 'model'; everything else is 'user'.
  const role = message.role === 'assistant' ? 'model' : 'user';

  if (typeof message.content === 'string') {
    return { role, parts: [{ text: message.content }] };
  }

  const parts = [];
  for (const part of message.content ?? []) {
    if (part.type === 'text') {
      parts.push({ text: part.text });
    } else if (part.type === 'image_url' && part.image_url?.url) {
      parts.push(await toInlineImage(part.image_url.url, signal));
    }
  }
  return { role, parts };
}

/**
 * Split the OpenAI-style message list into Gemini's shape.
 *
 * Gemini carries the system prompt out of band in `config.systemInstruction`
 * rather than as a first message, so any system role is lifted out here.
 */
async function toRequest({ system, messages, signal }) {
  const systemParts = [];
  const contents = [];

  for (const message of messages ?? []) {
    if (message.role === 'system') {
      if (typeof message.content === 'string') systemParts.push(message.content);
      continue;
    }
    contents.push(await toContent(message, signal));
  }

  const systemInstruction = [system, ...systemParts].filter(Boolean).join('\n\n');
  return { contents, systemInstruction: systemInstruction || undefined };
}

/**
 * @param {{system: string, messages: Array<{role, content}>, signal?: AbortSignal,
 *          maxTokens?: number, model?: string}} params
 * @returns {AsyncGenerator<string>} text deltas
 */
export async function* streamChat({ system, messages, signal, maxTokens, model }) {
  const { contents, systemInstruction } = await toRequest({ system, messages, signal });

  const stream = await gemini().models.generateContentStream({
    model: model || config.gemini.model,
    contents,
    config: {
      systemInstruction,
      temperature: 0.3,
      maxOutputTokens: maxTokens || config.gemini.maxTokens,
      abortSignal: signal,
    },
  });

  for await (const chunk of stream) {
    // `.text` concatenates the text parts of the chunk; undefined on a chunk
    // that carries only metadata (safety ratings, usage, finish reason).
    const delta = chunk.text;
    if (delta) yield delta;
  }
}

/** One-shot, non-streaming completion — the vision path uses this. */
export async function chatOnce({ system, messages, model, maxTokens = 800, signal }) {
  const { contents, systemInstruction } = await toRequest({ system, messages, signal });

  const response = await gemini().models.generateContent({
    model: model || config.gemini.model,
    contents,
    config: {
      systemInstruction,
      temperature: 0.2,
      maxOutputTokens: maxTokens,
      abortSignal: signal,
    },
  });

  return response.text || '';
}

export function aiAvailable() {
  return Boolean(config.gemini.apiKey) && !config.ai.disabled;
}
