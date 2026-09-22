import { jest } from '@jest/globals';

/* ============================================================================
   aiClient routes between Gemini (primary) and Groq (fallback).

   Worth testing directly: the rules encode judgement calls that are invisible
   from the outside — that a mid-stream failure must NOT restart on the other
   provider, and that a user abort must not burn the fallback's quota.
   ========================================================================= */

const geminiStream = jest.fn();
const geminiOnce = jest.fn();
const geminiAvailable = jest.fn(() => true);
const groqStream = jest.fn();
const groqOnce = jest.fn();
const groqAvailable = jest.fn(() => true);

jest.unstable_mockModule('../features/ai/geminiClient.js', () => ({
  streamChat: geminiStream,
  chatOnce: geminiOnce,
  aiAvailable: geminiAvailable,
  FIRST_TOKEN_TIMEOUT_MS: 10000,
}));
jest.unstable_mockModule('../features/ai/groqClient.js', () => ({
  streamChat: groqStream,
  chatOnce: groqOnce,
  aiAvailable: groqAvailable,
  FIRST_TOKEN_TIMEOUT_MS: 10000,
}));

const { streamChat, chatOnce, aiAvailable, activeProvider } = await import(
  '../features/ai/aiClient.js'
);

/** Build an async generator that yields the given deltas, then optionally throws. */
const generator = (deltas, throwAfter = null) =>
  async function* () {
    for (const d of deltas) yield d;
    if (throwAfter) throw throwAfter;
  };

const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

const collect = async (iter) => {
  const out = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
};

beforeEach(() => {
  jest.clearAllMocks();
  geminiAvailable.mockReturnValue(true);
  groqAvailable.mockReturnValue(true);
});

describe('provider selection', () => {
  test('Gemini answers when it is available', async () => {
    geminiStream.mockImplementation(generator(['hello']));
    expect(activeProvider()).toBe('gemini');
    expect(await collect(streamChat({ system: 's', messages: [] }))).toEqual(['hello']);
    expect(groqStream).not.toHaveBeenCalled();
  });

  test('Groq answers when Gemini has no key', async () => {
    geminiAvailable.mockReturnValue(false);
    groqStream.mockImplementation(generator(['from groq']));
    expect(activeProvider()).toBe('groq');
    expect(await collect(streamChat({ system: 's', messages: [] }))).toEqual(['from groq']);
    expect(geminiStream).not.toHaveBeenCalled();
  });

  test('aiAvailable is false only when no provider has a key', async () => {
    expect(aiAvailable()).toBe(true);
    geminiAvailable.mockReturnValue(false);
    expect(aiAvailable()).toBe(true);
    groqAvailable.mockReturnValue(false);
    expect(aiAvailable()).toBe(false);
  });
});

describe('streaming fallback', () => {
  test('falls back to Groq when Gemini is rate limited before any token', async () => {
    // The reason the fallback exists: Gemini's free tier caps requests per
    // minute, and the concierge must not go dark when a building gets busy.
    geminiStream.mockImplementation(generator([], httpError(429)));
    groqStream.mockImplementation(generator(['rescued']));
    expect(await collect(streamChat({ system: 's', messages: [] }))).toEqual(['rescued']);
  });

  test('does NOT fall back once a token has been emitted', async () => {
    // Half the answer is already rendered in the browser; restarting would
    // append a second, differently-worded answer to the first half.
    geminiStream.mockImplementation(generator(['half an ans'], httpError(500)));
    await expect(collect(streamChat({ system: 's', messages: [] }))).rejects.toThrow('HTTP 500');
    expect(groqStream).not.toHaveBeenCalled();
  });

  test('does NOT fall back when the caller aborted', async () => {
    // The visitor closed the tab or typed again — nobody is waiting for this.
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    geminiStream.mockImplementation(generator([], abort));
    await expect(collect(streamChat({ system: 's', messages: [] }))).rejects.toThrow('aborted');
    expect(groqStream).not.toHaveBeenCalled();
  });

  test('propagates the error when every provider fails', async () => {
    geminiStream.mockImplementation(generator([], httpError(429)));
    groqStream.mockImplementation(generator([], httpError(503)));
    await expect(collect(streamChat({ system: 's', messages: [] }))).rejects.toThrow('HTTP 503');
  });

  test('a bad key falls through rather than failing the request', async () => {
    geminiStream.mockImplementation(generator([], httpError(401)));
    groqStream.mockImplementation(generator(['still works']));
    expect(await collect(streamChat({ system: 's', messages: [] }))).toEqual(['still works']);
  });
});

describe('chatOnce fallback', () => {
  test('retries on the next provider — no partial output to protect', async () => {
    geminiOnce.mockRejectedValue(httpError(429));
    groqOnce.mockResolvedValue('groq answer');
    expect(await chatOnce({ messages: [] })).toBe('groq answer');
  });

  test('each provider is asked for its own model, not a shared name', async () => {
    // Model names are provider-specific; handing Groq a Gemini model id would
    // 400 on every fallback.
    geminiOnce.mockRejectedValue(httpError(500));
    groqOnce.mockResolvedValue('ok');
    await chatOnce({ messages: [], role: 'design' });
    expect(geminiOnce.mock.calls[0][0].model).toMatch(/gemini/);
    expect(groqOnce.mock.calls[0][0].model).not.toMatch(/gemini/);
  });

  test('a provider with no model for the role is skipped, not called blind', async () => {
    // Groq lost its multimodal model when the Llama family was retired, so
    // vision is Gemini-only. Falling through to Groq with model=undefined
    // would send a plan image to a text model and get a 400 back.
    geminiOnce.mockRejectedValue(httpError(500));
    groqOnce.mockResolvedValue('should never be reached');
    await expect(chatOnce({ messages: [], role: 'vision' })).rejects.toThrow('HTTP 500');
    expect(groqOnce).not.toHaveBeenCalled();
  });
});
