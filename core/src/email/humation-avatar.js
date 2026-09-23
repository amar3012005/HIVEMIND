import { createAvatar } from '@humation/core';
import { humation1 } from '@humation/assets-humation-1';

const ARCHETYPE_TO_LANE = Object.freeze({
  strategist: 'Strategist',
  coordinator: 'Strategist',
  builder: 'Builder',
  skeptic: 'Skeptic',
  investigator: 'Researcher',
  researcher: 'Researcher',
  generalist: 'Communicator',
  communicator: 'Communicator',
});

const LANE_COLORS = Object.freeze({
  Strategist: '#a855f7',
  Builder: '#117dff',
  Skeptic: '#f59e0b',
  Researcher: '#10b981',
  Communicator: '#ec4899',
});

const LANE_BACKGROUNDS = Object.freeze({
  Strategist: '#f3e8ff',
  Builder: '#eaf3ff',
  Skeptic: '#fff7e6',
  Researcher: '#e8f8f2',
  Communicator: '#fceaf4',
});

// Increment whenever the public avatar bytes change. Lifecycle email images
// are immutable, and mailbox image proxies otherwise keep the previous SVG.
export const HUMATION_AVATAR_ASSET_VERSION = '2';

// The small founding team shown in lifecycle email. These are deterministic
// Humation identities rather than newly invented image assets, so every
// mailbox receives the same canonical BRAIN / OS / VOICE characters.
export const HIVEMIND_EMAIL_TEAM = Object.freeze([
  Object.freeze({ id: 'hivemind-brain', name: 'BRAIN', roleArchetype: 'Strategist' }),
  Object.freeze({ id: 'hivemind-os', name: 'OS', roleArchetype: 'Builder' }),
  Object.freeze({ id: 'hivemind-voice', name: 'VOICE', roleArchetype: 'Communicator' }),
]);

function escapeAttribute(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function resolveHumationLane(roleArchetype) {
  const raw = String(roleArchetype || 'Communicator').trim();
  if (LANE_COLORS[raw]) return raw;
  const lower = raw.toLowerCase();
  if (ARCHETYPE_TO_LANE[lower]) return ARCHETYPE_TO_LANE[lower];
  if (/risk|quality|compliance|legal|counsel|privacy|audit|security/.test(lower)) return 'Skeptic';
  if (/research|analyst|insight|intelligence|quantitative|seo/.test(lower)) return 'Researcher';
  if (/strateg|design lead|brand|treasury|finance lead/.test(lower)) return 'Strategist';
  if (/builder|engineer|developer|architect|technical/.test(lower)) return 'Builder';
  return 'Communicator';
}

export function humationLaneVisual(roleArchetype) {
  const lane = resolveHumationLane(roleArchetype);
  return { lane, color: LANE_COLORS[lane], background: LANE_BACKGROUNDS[lane] };
}

function cssColor(value, fallback) {
  const normalized = String(value || '').trim().replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(normalized) ? `#${normalized.toUpperCase()}` : fallback;
}

export function renderHumationAvatarSvg(employee = {}, { size = 64 } = {}) {
  const lane = resolveHumationLane(employee.roleArchetype || employee.role);
  const seed = String(employee.id || employee.slug || employee.name || 'agent');
  const title = String(employee.name || lane);
  const data = createAvatar(humation1, {
    seed,
    background: 'transparent',
    colors: {
      stroke: '#171717',
      hair: '#241b18',
      skin: '#f4c7ab',
      clothes: LANE_COLORS[lane],
      bottom: '#334155',
    },
  }).toRenderData();
  const width = Math.max(24, Math.min(256, Number(size) || 64));
  const height = (width * data.viewBox.height) / data.viewBox.width;
  const resolvedColors = Object.fromEntries(Object.entries(data.colors || {})
    .map(([slot, color]) => [slot, cssColor(color, '#000000')]));
  // Many mailbox renderers and image proxies do not preserve CSS custom
  // properties inside external SVG images. Bake the palette into every path
  // while retaining variables as harmless metadata for browser consumers.
  const content = data.content.replace(/var\(--hm-([a-z0-9_-]+),\s*[^)]+\)/gi,
    (match, slot) => resolvedColors[slot] || match);
  const style = Object.entries(resolvedColors)
    .map(([slot, color]) => `--hm-${slot}:${color}`)
    .join(';');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${data.viewBox.x} ${data.viewBox.y} ${data.viewBox.width} ${data.viewBox.height}" width="${width}" height="${height}" role="img" aria-label="${escapeAttribute(title)}" style="${style}"><title>${escapeAttribute(title)}</title><g>${content}</g></svg>`;
}

export function humationAvatarPublicUrl(employee = {}, baseUrl = '') {
  const origin = String(baseUrl || process.env.HIVEMIND_PUBLIC_API_URL || 'https://api.singulancelabs.com').replace(/\/$/, '');
  const seed = String(employee.id || employee.slug || employee.name || 'agent').slice(0, 160);
  const role = resolveHumationLane(employee.roleArchetype || employee.role);
  return `${origin}/v1/public/humation-avatar.svg?seed=${encodeURIComponent(seed)}&role=${encodeURIComponent(role)}&v=${HUMATION_AVATAR_ASSET_VERSION}`;
}

/**
 * A conservative table layout for transactional email. Email clients do not
 * consistently support flex, pseudo-elements, or SVG data URLs, so the team
 * uses our public, cache-versioned avatar endpoint in regular img tags.
 */
export function renderHivemindEmailTeam({ caption = 'YOUR TEAM IS READY', variant = 'card' } = {}) {
  const faceStrip = variant === 'face-strip';
  const people = HIVEMIND_EMAIL_TEAM.map((member) => {
    const lane = humationLaneVisual(member.roleArchetype);
    // Match AgentAvatar in the product navbar: render the complete square
    // Humation SVG inside the circular lane frame. Do not manually zoom or
    // translate the source—individual seeds have different head positions,
    // which made the previous email crop cut faces off.
    const avatar = faceStrip
      ? `<div style="width:48px;height:48px;margin:0 auto 6px;border:2px solid #ffffff;border-radius:50%;background:${lane.background};overflow:hidden;box-shadow:0 1px 4px rgba(15,23,42,.12)"><img src="${humationAvatarPublicUrl(member)}" width="48" height="48" alt="${escapeAttribute(member.name)}" style="display:block;width:48px;height:48px;border:0" /></div>`
      : `<div style="width:58px;height:58px;margin:0 auto 7px;border:1px solid ${lane.color};border-radius:50%;background:${lane.background};overflow:hidden"><img src="${humationAvatarPublicUrl(member)}" width="58" height="58" alt="${escapeAttribute(member.name)}" style="display:block;width:58px;height:58px;border:0" /></div>`;
    const width = faceStrip ? 60 : 72;
    const padding = faceStrip ? '0 2px' : '0 4px';
    return `<td width="${width}" align="center" valign="top" style="width:${width}px;padding:${padding}">${avatar}<div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:${faceStrip ? 8 : 9}px;line-height:12px;font-weight:700;letter-spacing:${faceStrip ? 1.2 : 1.4}px;color:#666">${escapeAttribute(member.name)}</div></td>`;
  }).join('');
  if (faceStrip) {
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;margin:18px 0 0"><tr><td align="left"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${people}</tr></table></td></tr></table>`;
  }
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;margin:0 0 22px"><tr><td style="padding:14px 14px 13px;background:#f7f7f4;border:1px solid #e8e6df;border-radius:8px"><div style="margin:0 0 10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:9px;line-height:12px;font-weight:700;letter-spacing:1.5px;color:#117dff">${escapeAttribute(caption)}</div><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${people}</tr></table></td></tr></table>`;
}
