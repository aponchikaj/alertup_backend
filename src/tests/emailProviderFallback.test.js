import { jest } from '@jest/globals';

/* ============================================================================
   sendEmail routes between Resend (primary) and SendGrid (fallback).

   This path carries password resets, 2FA codes and building invites, and the
   Resend cutover has a window where the domain is not yet verified. The rule
   that matters: a failure must still reach the caller as a THROW, because the
   auth routes roll their work back in a catch block.
   ========================================================================= */

const resendSend = jest.fn();
const resendAvailable = jest.fn(() => true);
const sendgridSend = jest.fn();
const sendgridAvailable = jest.fn(() => true);

jest.unstable_mockModule('../services/email/resendProvider.js', () => ({
  name: 'resend',
  send: resendSend,
  available: resendAvailable,
}));
jest.unstable_mockModule('../services/email/sendgridProvider.js', () => ({
  name: 'sendgrid',
  send: sendgridSend,
  available: sendgridAvailable,
}));

const { default: sendMail } = await import('../services/sendEmail.js');

const ARGS = ['someone@example.com', 'Subject', 'Body text'];

beforeEach(() => {
  jest.clearAllMocks();
  resendAvailable.mockReturnValue(true);
  sendgridAvailable.mockReturnValue(true);
  resendSend.mockResolvedValue({ id: 'r1' });
  sendgridSend.mockResolvedValue({ id: 's1' });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

test('sends through Resend and never touches SendGrid', async () => {
  await expect(sendMail(...ARGS)).resolves.toEqual({
    Success: true,
    Message: 'Email sent successfully',
  });
  expect(resendSend).toHaveBeenCalledTimes(1);
  expect(sendgridSend).not.toHaveBeenCalled();
});

test('falls back to SendGrid when Resend rejects', async () => {
  // The expected cutover failure: the domain has not finished verifying on
  // Resend yet. A password reset must still go out.
  resendSend.mockRejectedValue(new Error('Domain is not verified'));
  await expect(sendMail(...ARGS)).resolves.toEqual({
    Success: true,
    Message: 'Email sent successfully',
  });
  expect(sendgridSend).toHaveBeenCalledTimes(1);
});

test('uses SendGrid directly when Resend has no key', async () => {
  resendAvailable.mockReturnValue(false);
  await sendMail(...ARGS);
  expect(resendSend).not.toHaveBeenCalled();
  expect(sendgridSend).toHaveBeenCalledTimes(1);
});

test('THROWS when every provider fails', async () => {
  // Never resolve on failure: inviteService rolls the invite back in its
  // catch block, and the auth routes tell the user the code was not sent.
  resendSend.mockRejectedValue(new Error('Domain is not verified'));
  sendgridSend.mockRejectedValue(new Error('Maximum credits exceeded'));
  await expect(sendMail(...ARGS)).rejects.toThrow('Maximum credits exceeded');
});

test('THROWS when no provider is configured at all', async () => {
  resendAvailable.mockReturnValue(false);
  sendgridAvailable.mockReturnValue(false);
  await expect(sendMail(...ARGS)).rejects.toThrow('No email provider is configured');
});

test('rejects an incomplete message before reaching a provider', async () => {
  await expect(sendMail('', 'Subject', 'Body')).rejects.toThrow('Missing required email fields');
  await expect(sendMail('a@b.c', 'Subject', '')).rejects.toThrow('Missing required email fields');
  expect(resendSend).not.toHaveBeenCalled();
});

test('passes html and replyTo through to the provider', async () => {
  await sendMail('a@b.c', 'Subj', 'text', 'reply@alertup.world', '<p>hi</p>');
  expect(resendSend).toHaveBeenCalledWith(
    expect.objectContaining({
      to: 'a@b.c',
      subject: 'Subj',
      text: 'text',
      html: '<p>hi</p>',
      replyTo: 'reply@alertup.world',
    }),
  );
});
