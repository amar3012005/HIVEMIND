import { CARTESIA, escapeHtml, lifecycleEmailShell } from './cartesia-lifecycle.js';

const COPY = {
  en: {
    subject: 'Your HIVEMIND invitation link is ready to share',
    eyebrow: 'YOUR TRUSTED HIVEMIND INVITATION',
    heading: 'Your private HIVEMIND invitation is ready.',
    intro: 'Now it is your turn to invite the people you trust. Share this private link from any device; every recipient sees that they were invited by you.',
    trial: 'FREE TRIAL', credits: 'MONTHLY CREDITS', plan: 'TRIAL PLAN',
    action: 'OPEN YOUR SHARE PAGE', note: 'The share page uses your device share sheet when available, with copy-link and WhatsApp fallback. No payment method is required for recipients to begin.',
  },
  de: {
    subject: 'Dein HIVEMIND-Einladungslink ist bereit zum Teilen',
    eyebrow: 'DEINE VERTRAUENSWÜRDIGE HIVEMIND-EINLADUNG',
    heading: 'Deine private HIVEMIND-Einladung ist bereit.',
    intro: 'Jetzt bist du dran: Lade Menschen ein, denen du vertraust. Teile diesen privaten Link von jedem Gerät aus; jede eingeladene Person sieht, dass die Einladung von dir kommt.',
    trial: 'KOSTENLOSE TESTPHASE', credits: 'MONATLICHE CREDITS', plan: 'TESTPLAN',
    action: 'TEILSEITE ÖFFNEN', note: 'Die Teilseite verwendet, wenn verfügbar, die Teilen-Funktion deines Geräts sowie Link-kopieren- und WhatsApp-Alternativen. Zum Start ist keine Zahlungsmethode erforderlich.',
  },
};

export function renderPartnerReferralInvitation({ referrerName, invitationUrl, offer, welcomeMessage = null, language = 'en' }) {
  const name = String(referrerName || 'A trusted partner').trim();
  const copySet = COPY[language === 'de' ? 'de' : 'en'];
  const trial = Number(offer?.trial_days || 0);
  const credits = Number(offer?.monthly_credits || 0).toLocaleString('en-US');
  const plan = String(offer?.plan || 'HIVEMIND').toUpperCase();
  const subject = copySet.subject;
  const shareUrl = `${invitationUrl}${invitationUrl.includes('?') ? '&' : '?'}share=1`;
  const personalLine = welcomeMessage ? `<p class="copy">${escapeHtml(welcomeMessage)}</p>` : '';
  const body = `<tr><td class="section"><div class="eyebrow">${copySet.eyebrow}</div><h1 class="h1">${copySet.heading}</h1><p class="copy">${copySet.intro}</p>${personalLine}<table role="presentation" width="100%" class="stats"><tr><td class="stat"><div class="stat-label">${copySet.trial}</div><div class="stat-value">${trial} days</div></td><td class="stat"><div class="stat-label">${copySet.credits}</div><div class="stat-value">${credits}</div></td><td class="stat"><div class="stat-label">${copySet.plan}</div><div class="stat-value" style="font-size:15px">${escapeHtml(plan)}</div></td></tr></table><div class="founder-note"><div class="founder-quote">The people you invite will enter a prepared path—not an empty workspace. Their first company context, trial and access are verified server-side.</div><div class="founder-signature">SINGULANCE · HIVEMIND</div></div><a class="action" href="${escapeHtml(shareUrl)}">${copySet.action} →</a><p class="copy" style="font-size:11px;color:${CARTESIA.muted}">${copySet.note}</p></td></tr>`;
  return {
    subject,
    text: `${copySet.heading} ${copySet.intro} ${trial}-day ${plan} trial, ${credits} monthly credits. ${copySet.action}: ${shareUrl}`,
    html: lifecycleEmailShell({ title: subject, preheader: `${name}, your referral link is ready to share.`, body }),
  };
}
