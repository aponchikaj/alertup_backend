import { createChallenge, verifyChallenge } from './challenge.js';

describe('emergency arming challenge', () => {
  test('the right answer to a fresh token verifies', () => {
    const { question, token } = createChallenge();
    const [a, b] = question.split(' + ').map(Number);
    expect(verifyChallenge(token, a + b)).toBe(true);
  });

  test('a wrong answer fails', () => {
    const { question, token } = createChallenge();
    const [a, b] = question.split(' + ').map(Number);
    expect(verifyChallenge(token, a + b + 1)).toBe(false);
  });

  test('tampered and malformed tokens fail closed', () => {
    const { question, token } = createChallenge();
    const [a, b] = question.split(' + ').map(Number);
    expect(verifyChallenge(token.slice(0, -2) + 'ff', a + b)).toBe(false);
    for (const bad of [undefined, null, '', 'x', '123.', '.abc']) {
      expect(verifyChallenge(bad, a + b)).toBe(false);
    }
  });

  test('an expired token fails even with the right answer', () => {
    // Forged expiry in the past cannot carry a valid signature anyway, but an
    // honest token that aged out must also be refused.
    const { question, token } = createChallenge();
    const [a, b] = question.split(' + ').map(Number);
    const [exp, sig] = token.split('.');
    const stale = `${Number(exp) - 10 * 60 * 1000}.${sig}`;
    expect(verifyChallenge(stale, a + b)).toBe(false);
  });
});
