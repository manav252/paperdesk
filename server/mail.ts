/**
 * Invitation emails, sent through Brevo's transactional email API. Off unless BREVO_API_KEY and MAIL_FROM are set:
 * the invitation then stays a link the owner passes on.
 */
const API_URL = process.env.MAIL_API_URL ?? 'https://api.brevo.com/v3/smtp/email';
const KEY = process.env.BREVO_API_KEY ?? '';
const FROM = process.env.MAIL_FROM ?? '';
export const mailConfigured = !!(KEY && FROM);

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Returns whether the provider accepted the message, and its reason when it did not, for the project owner to read.
 * Never throws: a failed email must not fail the invitation.
 */
export async function sendInvite(invite: {
  to: string;
  project: string;
  role: string;
  inviter?: string;
  link: string;
}) {
  if (!mailConfigured) return { sent: false };
  const can = invite.role === 'viewer' ? 'view' : 'edit',
    who = invite.inviter ?? 'Someone';
  const text = `${who} invited you to ${can} “${invite.project}” on PaperDesk.\n\nOpen the project: ${invite.link}\n\nSign in with this email address (${invite.to}) to get access. If you were not expecting this, you can ignore this email.`;
  const html = `<p>${escapeHtml(who)} invited you to ${can} <strong>${escapeHtml(invite.project)}</strong> on PaperDesk.</p>
<p><a href="${escapeHtml(invite.link)}">Open the project</a></p>
<p>Sign in with this email address (${escapeHtml(invite.to)}) to get access. If you were not expecting this, you can ignore this email.</p>`;
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'api-key': KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: process.env.MAIL_FROM_NAME ?? 'PaperDesk', email: FROM },
        to: [{ email: invite.to }],
        subject: `${who} invited you to “${invite.project}” on PaperDesk`,
        textContent: text,
        htmlContent: html,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return { sent: true };
    const body = (await response.json().catch(() => ({}))) as { message?: unknown };
    const reason = typeof body.message === 'string' ? body.message.slice(0, 300) : `status ${response.status}`;
    console.error(`Invitation email was refused (${response.status}): ${reason}`);
    return { sent: false, reason };
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'the email service could not be reached';
    console.error('Invitation email could not be sent:', reason);
    return { sent: false, reason };
  }
}
