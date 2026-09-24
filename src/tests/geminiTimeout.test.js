import { jest } from '@jest/globals';

/* ============================================================================
   Gemini is the DEFAULT provider, and its SDK has no request-timeout option —
   groq-sdk took one as a call option, `@google/genai` does not. So the
   first-token deadline has to be enforced in the adapter itself.

   Without it a hung Gemini stream has no deadline at all: it can only end when
   the visitor closes the tab. That is the one failure mode the Groq fallback
   exists to cover, so the timeout must also surface as a RETRYABLE error —
   an AbortError would be treated as "the caller went away" and would never
   fall over.
   ========================================================================= */

const generateContentStream = jest.fn();
const generateContent = jest.fn();

jest.unstable_mockModule('@google/genai', () => ({
  GoogleGenAI: class {
    constructor() {
      this.models = { generateContentStream, generateContent };
    }
  },
}));

const { streamChat } = await import('../features/ai/geminiClient.js');

const collect = async (iter) => {
  const out = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
};

/**
 * A stream that yields the given deltas and then stalls until it is aborted —
 * the shape of a provider that accepted the request and then went quiet.
 */
const stallingStream = (deltas = []) =>
  jest.fn(async ({ config }) => {
    const signal = config.abortSignal;
    return (async function* () {
      for (const text of deltas) yield { text };
      await new Promise((_resolve, reject) => {
        const fail = () =>
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        if (signal?.aborted) return fail();
        signal?.addEventListener('abort', fail, { once: true });
      });
    })();
  });

beforeEach(() => jest.clearAllMocks());

describe('first-token deadline', () => {
  test('rejects when no first token arrives before the deadline', async () => {
    generateContentStream.mockImplementation(stallingStream());

    const error = await collect(
      streamChat({ system: 's', messages: [], firstTokenTimeoutMs: 20 })
    ).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('TimeoutError');
  }, 5000);

  test('aborts the underlying request so the provider stops billing', async () => {
    let captured = null;
    generateContentStream.mockImplementation(async (req) => {
      captured = req.config.abortSignal;
      return stallingStream()(req);
    });

    await expect(
      collect(streamChat({ system: 's', messages: [], firstTokenTimeoutMs: 20 }))
    ).rejects.toThrow();
    expect(captured?.aborted).toBe(true);
  }, 5000);

  test('the timeout is retryable, so aiClient can fall over to Groq', async () => {
    generateContentStream.mockImplementation(stallingStream());

    const error = await collect(
      streamChat({ system: 's', messages: [], firstTokenTimeoutMs: 20 })
    ).catch((e) => e);

    // isRetryable() treats AbortError as "the caller left" and never retries it.
    expect(error.name).not.toBe('AbortError');
    // No HTTP status => isRetryable() reads it as a network-level failure.
    expect(error.status).toBeUndefined();
  }, 5000);

  test('the deadline covers the FIRST token only, not the gaps after it', async () => {
    generateContentStream.mockImplementation(stallingStream(['hello ', 'world']));
    // Long enough that the 20ms first-token deadline would have fired by now
    // if it were still armed after the first delta.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const error = await collect(
      streamChat({
        system: 's',
        messages: [],
        signal: controller.signal,
        firstTokenTimeoutMs: 20,
      })
    ).catch((e) => e);

    // Once text is flowing the stream is alive; only the caller abort ends it.
    expect(error.name).toBe('AbortError');
  }, 5000);

  test('a caller abort stays an AbortError and is not reported as a timeout', async () => {
    generateContentStream.mockImplementation(stallingStream());
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const error = await collect(
      streamChat({
        system: 's',
        messages: [],
        signal: controller.signal,
        firstTokenTimeoutMs: 5000,
      })
    ).catch((e) => e);

    expect(error.name).toBe('AbortError');
  }, 5000);
});
