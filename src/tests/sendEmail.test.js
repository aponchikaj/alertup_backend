import { jest } from '@jest/globals';

/* ============================================================================
   sendEmail is Resend-only since the SendGrid fallback was retired.

   The contract under test is the throw, not the send. Resend's SDK RESOLVES
   with { data, error } instead of rejecting, so a careless wrapper would
   report a failed send as a success — which is exactly how an earlier version
   of this file made every `catch` block in the auth routes unreachable, and
   inviteService's rollback along with them.
   ========================================================================= */

const emailsSend = jest.fn();
jest.unstable_mockModule('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: emailsSend } })),
}));

// config reads RESEND_API_KEY at import time, and setup.js blanks it.
process.env.RESEND_API_KEY = 'test-key';

const { default: sendMail } = await import('../services/sendEmail.js');

const ARGS = ['someone@example.com', 'Subject', 'Body text'];

beforeEach(() => {
  jest.clearAllMocks();
  emailsSend.mockResolvedValue({ data: { id: 'email_123' }, error: null });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

test('sends and reports the provider id back', async () => {
  await expect(sendMail(...ARGS)).resolves.toEqual({
    Success: true,
    Message: 'Email sent successfully',
    id: 'email_123',
  });
  expect(emailsSend).toHaveBeenCalledTimes(1);
});

test('THROWS when Resend resolves with an error instead of rejecting', async () => {
  // The whole reason this wrapper exists.
  emailsSend.mockResolvedValue({
    data: null,
    error: { name: 'validation_error', message: 'Domain is not verified' },
  });
  await expect(sendMail(...ARGS)).rejects.toThrow('Domain is not verified');
});

test('THROWS when the SDK itself rejects', async () => {
  emailsSend.mockRejectedValue(new Error('network down'));
  await expect(sendMail(...ARGS)).rejects.toThrow('network down');
});

test('rejects an incomplete message before calling the provider', async () => {
  await expect(sendMail('', 'Subject', 'Body')).rejects.toThrow('Missing required email fields');
  await expect(sendMail('a@b.c', '', 'Body')).rejects.toThrow('Missing required email fields');
  await expect(sendMail('a@b.c', 'Subject', '')).rejects.toThrow('Missing required email fields');
  expect(emailsSend).not.toHaveBeenCalled();
});

test('passes html and replyTo through, and omits them when absent', async () => {
  await sendMail('a@b.c', 'Subj', 'text', 'reply@alertup.world', '<p>hi</p>');
  expect(emailsSend).toHaveBeenCalledWith(
    expect.objectContaining({
      to: 'a@b.c',
      subject: 'Subj',
      text: 'text',
      html: '<p>hi</p>',
      replyTo: 'reply@alertup.world',
    }),
  );

  emailsSend.mockClear();
  await sendMail('a@b.c', 'Subj', 'text', null, null);
  const payload = emailsSend.mock.calls[0][0];
  expect(payload).not.toHaveProperty('html');
  expect(payload).not.toHaveProperty('replyTo');
});
