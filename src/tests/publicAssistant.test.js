import request from 'supertest';
import app from '../../server.js';
import { publicSystemPrompt } from '../features/ai/publicAssistant.routes.js';

/* The public assistant is anonymous: what's testable is the guardrails —
   input validation, the SSE fallback contract, and the prompt's hard rules. */

describe('POST /api/ai/ask', () => {
  test('rejects malformed bodies', async () => {
    const res = await request(app).post('/api/ai/ask').send({ messages: [] });
    expect(res.status).toBe(422);
  });

  test('rejects oversized messages (anonymous caps apply)', async () => {
    const res = await request(app)
      .post('/api/ai/ask')
      .send({ messages: [{ role: 'user', content: 'x'.repeat(501) }] });
    expect(res.status).toBe(422);
  });

  test('streams the static fallback when no model is configured', async () => {
    const res = await request(app)
      .post('/api/ai/ask')
      .send({ messages: [{ role: 'user', content: 'What is AlertUp?' }] });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('"fallback":true');
    expect(res.text).toContain('"done":true');
  });

  test('needs no authentication', async () => {
    // No cookie on purpose — a 401/403 here would break the marketing pages.
    const res = await request(app)
      .post('/api/ai/ask')
      .send({ messages: [{ role: 'user', content: 'hi' }] });
    expect([200]).toContain(res.status);
  });
});

describe('publicSystemPrompt', () => {
  test('carries the product facts and the hard rules', () => {
    const prompt = publicSystemPrompt('en');
    expect(prompt).toContain('indoor wayfinding');
    expect(prompt).toContain('/pricing');
    expect(prompt).toContain('NEVER state concrete prices');
    expect(prompt).toContain('<user_input>');
    expect(prompt).toContain('Reply ONLY in English');
  });

  test('locale switches the reply language, not the scaffold', () => {
    expect(publicSystemPrompt('ka')).toContain('Reply ONLY in Georgian');
  });
});
