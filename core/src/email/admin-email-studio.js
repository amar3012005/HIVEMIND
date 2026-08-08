const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The Admin surface sends only these low-risk, server-owned messages. Secure
// enterprise invitations remain on their dedicated lifecycle so an activation
// link and its one-time code can never be hand-authored in the browser.
export const ADMIN_EMAIL_TEMPLATES = Object.freeze({
  welcome_signup: 'Welcome to HIVEMIND',
  welcome_login: 'Welcome back to HIVEMIND',
});

function boundedText(value, label, maxLength, { required = false } = {}) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (required && !text) throw new Error(`${label} is required`);
  if (text.length > maxLength) throw new Error(`${label} is too long`);
  return text;
}

/**
 * Normalize the only inputs an operator may supply to a manual transaction.
 * The sender, template markup and destination app URL remain server-owned.
 */
export function normalizeAdminEmailMessage(input = {}, { appUrl } = {}) {
  const templateId = boundedText(input.template_id, 'Template', 64, { required: true });
  if (!Object.hasOwn(ADMIN_EMAIL_TEMPLATES, templateId)) throw new Error('Template is unavailable');

  const to = boundedText(input.to, 'Recipient email', 254, { required: true }).toLowerCase();
  if (!EMAIL_ADDRESS.test(to)) throw new Error('Recipient email is invalid');

  const name = boundedText(input.name, 'Recipient name', 120) || to.split('@')[0];
  return {
    templateId,
    to,
    vars: { name, email: to, appUrl },
  };
}
