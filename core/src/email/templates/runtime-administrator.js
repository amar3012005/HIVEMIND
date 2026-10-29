import { escapeHtml, CARTESIA } from './cartesia-lifecycle.js';
import { renderSingulanceTransactionalEmail } from './singulance-transactional.js';

export const RUNTIME_ADMIN_TEMPLATE_VERSION = 'runtime-administrator-v1';
/** Reuses the existing email brand shell; only Runtime's message composition differs. */
export function renderRuntimeAdministratorEmail({ companyName, administratorName, subject, message, kind, connection, conversationUrl, portraitUrl, sender, year = new Date().getFullYear() }) {
 // An employee's own notice is signed by that employee; Runtime's notices stay signed by Runtime.
 const author = sender?.name || 'Runtime';
 const title = sender ? `${sender.role} · ${companyName}` : `Your AI Chief of Staff · ${companyName}`;
 const firstName = String(administratorName || '').trim().split(/\s+/)[0] || 'there';
 const opening = sender ? `Hi ${firstName}, this is ${sender.name}, your ${sender.role} at ${companyName}.` : `Hi ${firstName}, this is Runtime from ${companyName}.`;
 const e = escapeHtml;
 const label = kind === 'completion' ? 'Work completed' : kind === 'approval' ? 'Your approval is needed' : 'Your input is needed';
 const button = connection ? `Connect ${connection.appLabel}` : kind === 'completion' ? 'View result' : 'Review request';
 const actionUrl=action=>{const url=new URL(conversationUrl);url.searchParams.set('review',action);return url.href;};
 const actions=kind==='approval'&&!connection?[['Approve',actionUrl('approve')],['Decline',actionUrl('decline')]]:[[button,conversationUrl]];
 const actionHtml=actions.map(([label,url])=>`<a href="${e(url)}" style="display:inline-block;background:${CARTESIA.blue};color:white;text-decoration:none;font-size:15px;font-weight:700;padding:14px 24px;margin:4px;border-radius:8px">${e(label)}</a>`).join('');
 const safety='Sign in to HIVEMIND to review this request. Opening an email link never grants access, approves work, or resumes an employee.';
 const innerHtml = `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding-right:14px">${sender ? `<div style="width:56px;height:56px;border-radius:14px;background:#f1efe9;color:${CARTESIA.ink};font-size:24px;font-weight:700;line-height:56px;text-align:center">${e(author.slice(0,1))}</div>` : `<img src="${e(portraitUrl)}" width="56" height="56" alt="Runtime" style="display:block;border-radius:14px">`}</td><td><div style="font-size:22px;font-weight:700;color:${CARTESIA.ink}">${e(author)}</div><div style="font-size:13px;color:${CARTESIA.muted}">${e(title)}</div></td></tr></table><p style="margin:28px 0 12px;color:${CARTESIA.blue};font-size:12px;font-weight:700">${label}</p><h1 style="font-size:26px;line-height:34px;margin:0 0 22px">${e(subject)}</h1><p style="font-size:16px;line-height:26px">${e(opening)}</p><div style="font-size:16px;line-height:26px;color:${CARTESIA.body}">${e(message).replace(/\n/g, '<br>')}</div><p style="margin:28px 0">${actionHtml}</p>${kind === 'approval' ? `<p style="font-size:12px;color:#8f8f8f">Review the request in HIVEMIND and choose Approve or Decline. Opening this email or its link does not grant approval. ${e(safety)}</p>` : ''}<p style="font-size:15px;line-height:24px">${e(author)}</p>`;
 return { subject: `${companyName} · ${subject}`, html: renderSingulanceTransactionalEmail({ preheader: e(message.slice(0, 160)), innerHtml, year }), text: `${author} — ${companyName}\n\n${opening}\n\n${message}\n\n${actions.map(([label,url])=>`${label}: ${url}`).join('\n')}\n\n${kind==='approval'?safety:''}\n\n${author}` };
}
