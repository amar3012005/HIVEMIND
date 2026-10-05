import { escapeHtml, CARTESIA } from './cartesia-lifecycle.js';
import { renderSingulanceTransactionalEmail } from './singulance-transactional.js';

export const RUNTIME_ADMIN_TEMPLATE_VERSION = 'runtime-administrator-v1';
/** Reuses the existing email brand shell; only Runtime's message composition differs. */
export function renderRuntimeAdministratorEmail({ companyName, administratorName, subject, message, kind, conversationUrl, portraitUrl, year = new Date().getFullYear() }) {
 const e = escapeHtml;
 const label = kind === 'completion' ? 'Work completed' : kind === 'approval' ? 'Your approval is needed' : 'Your input is needed';
 const button = kind === 'completion' ? 'View result' : 'Review request';
 const innerHtml = `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding-right:14px"><img src="${e(portraitUrl)}" width="56" height="56" alt="Runtime" style="display:block;border-radius:14px"></td><td><div style="font-size:22px;font-weight:700;color:${CARTESIA.ink}">Runtime</div><div style="font-size:13px;color:${CARTESIA.muted}">Your AI Chief of Staff · ${e(companyName)}</div></td></tr></table><p style="margin:28px 0 12px;color:${CARTESIA.blue};font-size:12px;font-weight:700">${label}</p><h1 style="font-size:26px;line-height:34px;margin:0 0 22px">${e(subject)}</h1><p style="font-size:16px;line-height:26px">Hi ${e(administratorName || 'there')},</p><div style="font-size:16px;line-height:26px;color:${CARTESIA.body}">${e(message).replace(/\n/g, '<br>')}</div><p style="margin:28px 0"><a href="${e(conversationUrl)}" style="display:inline-block;background:${CARTESIA.blue};color:white;text-decoration:none;font-size:15px;font-weight:700;padding:14px 24px;border-radius:8px">${button}</a></p>${kind === 'approval' ? '<p style="font-size:12px;color:#8f8f8f">Review the request in HIVEMIND and choose Approve or Decline. Opening this email or its link does not grant approval.</p>' : ''}<p style="font-size:15px;line-height:24px">Runtime</p>`;
 return { subject: `${companyName} · ${subject}`, html: renderSingulanceTransactionalEmail({ preheader: e(message.slice(0, 160)), innerHtml, year }), text: `Runtime — ${companyName}\n\nHi ${administratorName || 'there'},\n\n${message}\n\n${button}: ${conversationUrl}\n\nRuntime` };
}
