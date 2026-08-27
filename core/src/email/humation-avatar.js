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
  return ARCHETYPE_TO_LANE[raw.toLowerCase()] || 'Communicator';
}

export function renderHumationAvatarSvg(employee = {}, { size = 64 } = {}) {
  const lane = resolveHumationLane(employee.roleArchetype || employee.role);
  const seed = String(employee.id || employee.slug || employee.name || 'agent');
  const title = String(employee.name || lane);
  const data = createAvatar(humation1, { seed, background: 'transparent' }).toRenderData();
  const width = Math.max(24, Math.min(256, Number(size) || 64));
  const height = (width * data.viewBox.height) / data.viewBox.width;
  const style = `--hm-clothes:${LANE_COLORS[lane]}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${data.viewBox.x} ${data.viewBox.y} ${data.viewBox.width} ${data.viewBox.height}" width="${width}" height="${height}" role="img" aria-label="${escapeAttribute(title)}" style="${style}"><title>${escapeAttribute(title)}</title><g>${data.content}</g></svg>`;
}

export function humationAvatarPublicUrl(employee = {}, baseUrl = '') {
  const origin = String(baseUrl || process.env.HIVEMIND_PUBLIC_API_URL || 'https://api.singulancelabs.com').replace(/\/$/, '');
  const seed = String(employee.id || employee.slug || employee.name || 'agent').slice(0, 160);
  const role = resolveHumationLane(employee.roleArchetype || employee.role);
  return `${origin}/v1/public/humation-avatar.svg?seed=${encodeURIComponent(seed)}&role=${encodeURIComponent(role)}`;
}
