/**
 * Escape a value before interpolating it into an HTML email body.
 *
 * Several routes drop user-supplied text (contact messages, report reasons,
 * display names) straight into the HTML we mail out. Unescaped, a submission
 * containing markup renders as live HTML in the recipient's mail client — which
 * for the contact form means an anonymous stranger can put a styled, on-brand
 * phishing link into the operator's inbox.
 */
export const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export default escapeHtml;
