import escapeHtml from './escapeHtml.js';

// Central place for transactional email HTML. Plain template-literal
// functions — templates live in git, not a provider dashboard. All dynamic
// values are HTML-escaped.

function layout({ title, bodyHtml, footerNote }) {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#111;">
    <div style="max-width:560px;margin:0 auto;padding:32px 16px;">
      <div style="background:#ffffff;border:1px solid #e5e5e5;border-radius:12px;padding:32px;">
        <h1 style="margin:0 0 16px;font-size:20px;color:#000;">${escapeHtml(title)}</h1>
        ${bodyHtml}
      </div>
      <p style="text-align:center;color:#888;font-size:12px;margin-top:16px;">
        ${footerNote ? escapeHtml(footerNote) : 'AlertUp — indoor wayfinding & emergency evacuation'}
      </p>
    </div>
  </body>
</html>`;
}

const button = (href, label) =>
  `<a href="${escapeHtml(href)}" style="display:inline-block;background:#000;color:#fff;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:bold;">${escapeHtml(label)}</a>`;

export function inviteEmail({ buildingName, roleName, inviterName, acceptUrl, expiresHours = 48 }) {
  const bodyHtml = `
    <p style="line-height:1.6;">${escapeHtml(inviterName || 'A building administrator')} invited you to join
    <strong>${escapeHtml(buildingName)}</strong> on AlertUp as <strong>${escapeHtml(roleName)}</strong>.</p>
    <p style="line-height:1.6;">As a team member you can help manage indoor maps, wayfinding and emergency
    evacuation for this building.</p>
    <p style="margin:24px 0;">${button(acceptUrl, 'Accept invitation')}</p>
    <p style="color:#666;font-size:13px;line-height:1.6;">This invitation expires in ${Number(expiresHours)} hours.
    If you did not expect it, you can ignore this email.</p>
    <p style="color:#666;font-size:12px;word-break:break-all;">If the button does not work, open this link:<br>${escapeHtml(acceptUrl)}</p>`;
  return {
    subject: `You're invited to ${buildingName} on AlertUp`,
    text: `${inviterName || 'A building administrator'} invited you to join ${buildingName} on AlertUp as ${roleName}. Accept: ${acceptUrl} (expires in ${expiresHours} hours)`,
    html: layout({ title: `Invitation to ${buildingName}`, bodyHtml }),
  };
}

export function verificationCodeEmail({ code, purpose }) {
  const bodyHtml = `
    <p style="line-height:1.6;">Your AlertUp ${escapeHtml(purpose)} code:</p>
    <p style="font-size:32px;letter-spacing:8px;font-weight:bold;margin:24px 0;color:#000;">${escapeHtml(String(code))}</p>
    <p style="color:#666;font-size:13px;">This code expires shortly. If you did not request it, ignore this email.</p>`;
  return {
    subject: `AlertUp ${purpose} code: ${code}`,
    text: `Your AlertUp ${purpose} code is ${code}. It expires shortly.`,
    html: layout({ title: `Your ${purpose} code`, bodyHtml }),
  };
}

export function roleChangedEmail({ buildingName, roleName }) {
  const bodyHtml = `
    <p style="line-height:1.6;">Your role in <strong>${escapeHtml(buildingName)}</strong> was changed to
    <strong>${escapeHtml(roleName)}</strong>.</p>`;
  return {
    subject: `Your role in ${buildingName} changed`,
    text: `Your role in ${buildingName} was changed to ${roleName}.`,
    html: layout({ title: 'Role updated', bodyHtml }),
  };
}

export function removedFromBuildingEmail({ buildingName }) {
  const bodyHtml = `
    <p style="line-height:1.6;">You were removed from <strong>${escapeHtml(buildingName)}</strong> on AlertUp.</p>`;
  return {
    subject: `Removed from ${buildingName}`,
    text: `You were removed from ${buildingName} on AlertUp.`,
    html: layout({ title: 'Membership removed', bodyHtml }),
  };
}
