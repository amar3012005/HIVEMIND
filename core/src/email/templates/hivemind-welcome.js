/**
 * Accessible, personalized welcome email.
 *
 * Keep this template self-contained. Remote product-tour images are fragile in
 * email clients: an unavailable image URL makes Gmail render the image alt
 * text as visible, linked content. Product education belongs behind the CTA,
 * where the web application can render it reliably.
 */

import { emailBrandLockup } from './cartesia-lifecycle.js';
import { renderHivemindEmailTeam } from '../humation-avatar.js';

const BLUE = '#117dff';
const BORDER = '#e7e4dd';
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

function hiddenPreheader(value) {
  return value
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;line-height:1px">${value}</div>`
    : '';
}

function accountWelcome({ name, appUrl, year, orgName, accountType, welcomeKind, hostingMode, onboardingEndsAt }) {
  const enterprise = String(accountType || '').startsWith('enterprise_');
  const returning = welcomeKind === 'login';
  const workspace = orgName || 'your workspace';
  const state = returning ? 'WELCOME BACK' : enterprise ? 'ENTERPRISE WORKSPACE ACTIVATED' : 'PERSONAL WORKSPACE ACTIVATED';
  const title = returning
    ? enterprise ? `Welcome back to ${workspace}, ${name}` : `Welcome back to HIVEMIND, ${name}`
    : enterprise ? `${workspace} is ready, ${name}` : `Welcome to your HIVEMIND, ${name}`;
  const copy = enterprise
    ? `Your enterprise AI Operating System is ready. Your AI workforce can work from ${workspace}'s approved company context while your organization retains control.${hostingMode === 'self_host' ? ' Your organization operates the memory infrastructure.' : ' Singulance hosts and operates your managed workspace.'}${onboardingEndsAt ? ` Your onboarding access is active until ${onboardingEndsAt}.` : ''}`
    : 'Your personal AI Operating System is ready. HIVEMIND gives your AI workforce the context you approve, so your knowledge can compound while you retain control.';
  return `<tr><td style="height:4px;background:${BLUE};font-size:1px;line-height:1px">&nbsp;</td></tr>
  <tr><td class="hm-head" style="padding:24px 34px 22px;background:#ffffff;text-align:left">
    ${emailBrandLockup({ compact: true })}
    <div style="margin-top:22px;font:700 9px/14px ${MONO};letter-spacing:2.5px;color:${BLUE}">HIVEMIND / SYSTEM MESSAGE</div>
    ${renderHivemindEmailTeam({ variant: 'face-strip' })}
  </td></tr>
  <tr><td class="hm-welcome" style="padding:38px 52px 40px;border-top:1px solid ${BORDER};background:#ffffff;text-align:left">
    <div style="font:700 8px/12px ${MONO};letter-spacing:2px;color:${BLUE}">${state}</div>
    <h1 class="hm-welcome-title" style="margin:20px 0 0;font-size:29px;line-height:35px;letter-spacing:-.4px;color:#0a0a0a">${title}</h1>
    <p style="margin:22px 0 0;max-width:560px;font-size:15px;line-height:27px;color:#525252">${copy}</p>
    <a href="${appUrl}" style="display:inline-block;margin-top:27px;padding:13px 22px;border-radius:6px;background:${BLUE};color:#ffffff;text-decoration:none;font-size:13px;font-weight:700">OPEN HIVEMIND</a>
    <p style="margin:27px 0 0;font-size:11px;color:#7b7b7b">The HIVEMIND team</p>
  </td></tr>
  <tr><td style="padding:18px 52px 21px;border-top:1px solid ${BORDER};background:#fbfbf8;font:8px/14px ${MONO};letter-spacing:.7px;color:#8a8a8a">SINGULANCE · HIVEMIND · OPERATING SYSTEM<br><span style="color:#aaaaaa">YOUR COMPANY, IN MOTION · © ${year} SINGULANCE LABS.</span></td></tr>`;
}

export function renderHivemindWelcomeEmail({
  preheader = '',
  name = '',
  appUrl = '',
  year = '',
  orgName = '',
  accountType = 'personal',
  welcomeKind = 'workspace',
  hostingMode = 'managed',
  onboardingEndsAt = '',
}) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>Welcome to HIVEMIND</title><style>
    body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}table,td{mso-table-lspace:0;mso-table-rspace:0}table{border-collapse:collapse!important}img{border:0;height:auto;line-height:100%;outline:none;text-decoration:none}
    @media only screen and (max-width:620px){.hm-frame{padding:0!important}.hm-shell{width:100%!important;max-width:100%!important;border-left:0!important;border-right:0!important}.hm-head{padding:20px 22px!important}.hm-welcome{padding:30px 22px 32px!important}.hm-welcome-title{font-size:25px!important;line-height:31px!important}.hm-footer{padding:15px 22px!important;font-size:8px!important;line-height:14px!important}}
  </style></head><body style="margin:0;padding:0;background:#f1f2ef;color:#0a0a0a;font-family:'Space Grotesk','Helvetica Neue',Arial,sans-serif">${hiddenPreheader(preheader)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f2ef"><tr><td class="hm-frame" align="center" style="padding:28px 12px 40px"><table class="hm-shell" role="presentation" width="760" cellpadding="0" cellspacing="0" style="width:760px;max-width:760px;background:#ffffff;border:1px solid ${BORDER};overflow:hidden">
    ${accountWelcome({ name, appUrl, year, orgName, accountType, welcomeKind, hostingMode, onboardingEndsAt })}
  </table></td></tr></table></body></html>`;
}
