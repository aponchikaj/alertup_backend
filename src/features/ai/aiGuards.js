// Input validation for the public AI chat endpoint. The endpoint is
// anonymous (scan pages have no login), so caps are strict.

export const MAX_MESSAGES = 6;
export const MAX_MESSAGE_CHARS = 500;
export const MAX_TOTAL_CHARS = 3000;

const ALLOWED_ROLES = new Set(['user', 'assistant']);

// Drop control characters (keeping newline and tab) and the delimiter tags we
// use to fence untrusted input inside the prompt.
const isControlChar = (code) =>
  (code < 32 && code !== 9 && code !== 10) || code === 127;

export function sanitizeText(text) {
  let out = '';
  for (const ch of String(text)) {
    if (!isControlChar(ch.codePointAt(0))) out += ch;
  }
  return out.replace(/<\/?user_input>/gi, '').trim();
}

/**
 * @param {unknown} body
 * @param {{maxMessageChars?: number, maxTotalChars?: number}} caps —
 *   overrides for authenticated endpoints. The strict defaults protect the
 *   ANONYMOUS concierge; the editor assistant is behind login + permissions
 *   and its assistant turns (design summaries) legitimately run longer.
 * @returns {{ok: true, messages: Array<{role, content}>, locale: 'en'|'ka'}
 *          |{ok: false, error: string}}
 */
export function validateChatBody(body, caps = {}) {
  const maxMessageChars = caps.maxMessageChars ?? MAX_MESSAGE_CHARS;
  const maxTotalChars = caps.maxTotalChars ?? MAX_TOTAL_CHARS;
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Invalid request body.' };
  }

  const locale = body.locale === 'ka' ? 'ka' : 'en';

  const raw = body.messages;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'messages must be a non-empty array.' };
  }
  if (raw.length > MAX_MESSAGES) {
    return { ok: false, error: `At most ${MAX_MESSAGES} messages are allowed.` };
  }

  const messages = [];
  let totalChars = 0;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: 'Each message must be an object.' };
    }
    if (!ALLOWED_ROLES.has(entry.role)) {
      return { ok: false, error: 'Message roles must be "user" or "assistant".' };
    }
    if (typeof entry.content !== 'string') {
      return { ok: false, error: 'Message content must be a string.' };
    }
    const content = sanitizeText(entry.content);
    if (content.length === 0) {
      return { ok: false, error: 'Messages cannot be empty.' };
    }
    if (content.length > maxMessageChars) {
      return {
        ok: false,
        error: `Messages are limited to ${maxMessageChars} characters.`,
      };
    }
    totalChars += content.length;
    messages.push({ role: entry.role, content });
  }

  if (totalChars > maxTotalChars) {
    return { ok: false, error: 'Conversation is too long.' };
  }
  if (messages[messages.length - 1].role !== 'user') {
    return { ok: false, error: 'The last message must be from the user.' };
  }

  return { ok: true, messages, locale };
}
