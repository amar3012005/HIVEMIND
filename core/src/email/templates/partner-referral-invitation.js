import { CARTESIA, escapeHtml, lifecycleEmailShell } from './cartesia-lifecycle.js';

export function renderPartnerReferralInvitation({ referrerName, invitationUrl, offer, welcomeMessage = null }) {
  const name = String(referrerName || 'A trusted partner').trim();
  const trial = Number(offer?.trial_days || 0);
  const credits = Number(offer?.monthly_credits || 0).toLocaleString('en-US');
  const plan = String(offer?.plan || 'HIVEMIND').toUpperCase();
  const subject = `${name} invited you to awaken your HIVEMIND`;
  const copy = welcomeMessage || `${name} has opened a private path for you to experience HIVEMIND with the same context-first company operating system they know.`;
  const body = `<tr><td class="section"><div class="eyebrow">A PRIVATE SINGULANCE INVITATION</div><h1 class="h1">${escapeHtml(name)} invited you to awaken your HIVEMIND.</h1><p class="copy">${escapeHtml(copy)}</p><table role="presentation" width="100%" class="stats"><tr><td class="stat"><div class="stat-label">FREE TRIAL</div><div class="stat-value">${trial} days</div></td><td class="stat"><div class="stat-label">MONTHLY CREDITS</div><div class="stat-value">${credits}</div></td><td class="stat"><div class="stat-label">TRIAL PLAN</div><div class="stat-value" style="font-size:15px">${escapeHtml(plan)}</div></td></tr></table><div class="founder-note"><div class="founder-quote">You are not entering an empty workspace. HIVEMIND will learn your company, prepare its first moves, and introduce the HyperAgents ready to work inside its memory.</div><div class="founder-signature">AMAR SAI · FOUNDER, SINGULANCE LABS</div></div><a class="action" href="${escapeHtml(invitationUrl)}">ACCEPT ${escapeHtml(name.toUpperCase())}'S INVITATION →</a><p class="copy" style="font-size:11px;color:${CARTESIA.muted}">This link may be shared by ${escapeHtml(name)}. No payment method is required to begin the trial. The exact invitation terms are verified again when your workspace is created.</p></td></tr>`;
  return {
    subject,
    text: `${name} invited you to awaken your HIVEMIND. ${trial}-day ${plan} trial, ${credits} monthly credits. No payment method is required. Accept: ${invitationUrl}`,
    html: lifecycleEmailShell({ title: subject, preheader: `${name} invited you to HIVEMIND.`, body }),
  };
}
