import { Router } from 'express';
import { aiChatLimiter, aiDailyLimiter } from '../../services/rateLimiter.js';
import { fail } from '../../utils/respond.js';
import { initSse, sendData } from '../realtime/sseHelpers.js';
import { validateChatBody } from './aiGuards.js';
import { buildSystemPrompt, fenceUserContent } from './promptBuilder.js';
import { fetchChatContext } from './contextFetcher.js';
import { streamChat, aiAvailable } from './groqClient.js';

const router = Router();

// Localized static fallbacks — the assistant failing must never block
// evacuation UX, so failures degrade to useful guidance instantly.
const FALLBACKS = {
  en: {
    normal:
      'The assistant is unavailable right now. Please use the destination search to find your way.',
    emergency:
      'The assistant is unavailable. Follow the highlighted route on screen to the nearest emergency exit. Do not use elevators.',
  },
  ka: {
    normal:
      'ასისტენტი ამჟამად მიუწვდომელია. გზის საპოვნელად გამოიყენეთ ძიება.',
    emergency:
      'ასისტენტი მიუწვდომელია. მიჰყევით ეკრანზე გამოსახულ მარშრუტს უახლოეს საევაკუაციო გასასვლელამდე. ნუ ისარგებლებთ ლიფტით.',
  },
};

// POST because EventSource can't send bodies; the client consumes the SSE
// stream via fetch + ReadableStream.
router.post('/api/ai/chat', aiChatLimiter, aiDailyLimiter, async (req, res) => {
  const parsed = validateChatBody(req.body);
  if (!parsed.ok) return fail(res, 422, parsed.error);

  const { messages, locale } = parsed;
  const { buildingId, nodeId, destinationNodeId } = req.body || {};

  const context = await fetchChatContext({ buildingId, nodeId, destinationNodeId });

  const fallbackText =
    FALLBACKS[locale][context.emergencyActive ? 'emergency' : 'normal'];

  initSse(res, { retryMs: 0 });

  if (!aiAvailable()) {
    sendData(res, { delta: fallbackText, fallback: true });
    sendData(res, { done: true });
    return res.end();
  }

  const system = buildSystemPrompt({ ...context, locale });
  const fenced = messages.map((m) =>
    m.role === 'user' ? { ...m, content: fenceUserContent(m.content) } : m
  );

  // Client walked away — stop paying for tokens nobody reads.
  const abort = new AbortController();
  req.on('close', () => abort.abort());

  try {
    let sentAny = false;
    for await (const delta of streamChat({ system, messages: fenced, signal: abort.signal })) {
      sentAny = true;
      sendData(res, { delta });
    }
    if (!sentAny) {
      sendData(res, { delta: fallbackText, fallback: true });
    }
    sendData(res, { done: true });
  } catch (err) {
    if (!abort.signal.aborted) {
      console.error('Groq stream error:', err.message);
      try {
        sendData(res, { delta: fallbackText, fallback: true });
        sendData(res, { done: true });
      } catch {
        // stream already gone
      }
    }
  }
  res.end();
});

export default router;
