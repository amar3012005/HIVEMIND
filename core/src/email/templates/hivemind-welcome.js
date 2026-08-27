/**
 * Hybrid welcome email: accessible personalized HTML followed by exact 2x
 * captures of the production Cartesia React experience.
 *
 * Email clients do not share a browser rendering engine. Screenshots are the
 * only dependable way to preserve the FE's precise typography, shadows,
 * gradients, logos, graph, and alternating layouts across Gmail and Outlook.
 */

import { emailBrandLockup } from './cartesia-lifecycle.js';

const BLUE = '#117dff';
const BORDER = '#e7e4dd';
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

const SECTIONS = [
  ['hero', 'SOVEREIGN MEMORY ENGINE · EU. Run your institution as an AI company. Memories, Knowledge Base, and Web Intel with &lt;50ms recall. What was the deployment fix from last Tuesday?'],
  ['memory-engine', 'Memory Engine 01. A memory that organizes itself. Semantic recall, evidence, contradiction resolution, and durable institutional memory.'],
  ['connectors', 'Connectors 02. Connect once. Remember forever. More than 40 integrations feeding one unified company memory.'],
  ['context-security', 'Context-savvy accuracy for the real world. Context-aware recall. Encryption that outlives the quantum threat.'],
  ['memory-graph', 'Memory Graph 03. See your mind. Rewind it. Navigate facts, decisions, people, evidence, and time.'],
  ['meeting-notes', 'AI Meeting Notes 04. Meetings become permanent knowledge with decisions, actions, and open questions.'],
  ['hyper-agents', 'Hyper Agents 05. Digital employees that actually act using your company memory and connected tools.'],
  ['tara', 'TARA and HIVEMIND 06. A voice that knows your business with live transcription, grounded reasoning, and speech.'],
  ['mcp-server', 'MCP Server 07. Your editor with total recall across Claude, Cursor, VS Code, memory, web, code, and time travel.'],
  ['sovereignty', 'Sovereignty 08. Memory stays inside your walls with GDPR-native Frankfurt hosting, BYOK, and self-hosting.'],
  ['final-cta', 'Stop starting from zero. Connect your first app and let your organization’s intelligence compound.'],
];

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
  return `<tr><td style="height:5px;background:${BLUE};font-size:1px;line-height:1px">&nbsp;</td></tr>
  <tr><td class="hm-welcome" style="padding:42px 52px 38px;background:#ffffff;text-align:left">
    <div style="font:700 9px/14px ${MONO};letter-spacing:2.5px;color:${BLUE}">HIVEMIND / SYSTEM MESSAGE</div>
    <div style="margin-top:17px">${emailBrandLockup({ compact: true })}</div>
    <div style="margin-top:42px;font:700 8px/12px ${MONO};letter-spacing:2px;color:${BLUE}">${state}</div>
    <h1 class="hm-welcome-title" style="margin:20px 0 0;font-size:29px;line-height:35px;letter-spacing:-.4px;color:#0a0a0a">${title}</h1>
    <p style="margin:22px 0 0;max-width:560px;font-size:15px;line-height:27px;color:#525252">${copy}</p>
    <a href="${appUrl}" style="display:inline-block;margin-top:27px;padding:13px 22px;border-radius:6px;background:${BLUE};color:#ffffff;text-decoration:none;font-size:13px;font-weight:700">OPEN HIVEMIND</a>
    <p style="margin:27px 0 0;font-size:11px;color:#7b7b7b">The HIVEMIND team</p>
  </td></tr>
  <tr><td style="padding:17px 52px 20px;border-top:1px solid ${BORDER};background:#ffffff;font:8px/13px ${MONO};letter-spacing:.6px;color:#8a8a8a">HIVEMIND · MEMORY RUNNING INSIDE EVERYTHING · © ${year} SINGULANCE LABS.</td></tr>`;
}

function productTour(assetBaseUrl, appUrl) {
  return SECTIONS.map(([file, alt], index) => `<tr><td style="padding:0;border-top:${index ? '0' : `1px solid ${BORDER}`};background:#fbfbf8;line-height:0"><a href="${appUrl}" style="display:block;text-decoration:none"><img src="${assetBaseUrl}/${file}@2x.png" width="760" alt="${alt}" style="display:block;width:100%;max-width:760px;height:auto;border:0;outline:none;text-decoration:none"></a></td></tr>`).join('');
}

export function renderHivemindWelcomeEmail({
  preheader = '',
  name = '',
  appUrl = '',
  assetBaseUrl = 'https://next.singulancelabs.com/email/welcome-cartesia/v1',
  year = '',
  orgName = '',
  accountType = 'personal',
  welcomeKind = 'workspace',
  hostingMode = 'managed',
  onboardingEndsAt = '',
}) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>Welcome to HIVEMIND</title><style>
    @media only screen and (max-width:620px){.hm-frame{padding:8px 5px!important}.hm-shell{width:100%!important;max-width:100%!important}.hm-welcome{padding:25px 22px 24px!important}.hm-welcome-title{font-size:24px!important;line-height:29px!important}.hm-footer{padding:12px!important;font-size:7px!important}}
  </style></head><body style="margin:0;padding:0;background:#f1f3f4;color:#0a0a0a;font-family:'Space Grotesk','Helvetica Neue',Arial,sans-serif">${hiddenPreheader(preheader)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f3f4"><tr><td class="hm-frame" align="center" style="padding:28px 12px 40px"><table class="hm-shell" role="presentation" width="760" cellpadding="0" cellspacing="0" style="width:760px;max-width:760px;background:#ffffff;border:1px solid ${BORDER};border-radius:8px;overflow:hidden">
    ${accountWelcome({ name, appUrl, year, orgName, accountType, welcomeKind, hostingMode, onboardingEndsAt })}
    <tr><td style="height:34px;background:#f1f3f4;border-top:1px solid ${BORDER};border-bottom:1px solid ${BORDER};font-size:1px;line-height:1px">&nbsp;</td></tr>
    ${productTour(assetBaseUrl.replace(/\/$/, ''), appUrl)}
    <tr><td class="hm-footer" align="center" style="padding:16px;border-top:1px solid ${BORDER};background:#ffffff;font:8px/13px ${MONO};letter-spacing:1px;color:#8a8a8a">HIVEMIND · MEMORY RUNNING INSIDE EVERYTHING · © ${year} SINGULANCE LABS.</td></tr>
  </table></td></tr></table></body></html>`;
}
