import crypto from 'node:crypto';
import { createAvatar } from '@humation/core';
import { humation1 } from '@humation/assets-humation-1';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { validateEmployeeAppearance } from '../employees/humation-appearance.js';

/**
 * Public, cookie-free PNG of an employee's saved Humation look, for email clients that block SVG.
 *
 * The URL is `/v1/public/employee-avatar/<look>.<signature>.png`. `<look>` encodes only the five part numbers, five
 * colors and background of the saved appearance, so the same URL always renders the same bytes (immutable cache),
 * a changed look is a new URL, and the URL carries no employee, organization, name or account data. The signature is
 * an HMAC over the look, so only looks that Core itself signed can be rendered.
 */
export const EMPLOYEE_AVATAR_PATH = '/v1/public/employee-avatar/';
const KEY_LABEL = 'hivemind:employee-avatar:v1';
const SLOTS = ['head', 'body', 'bottom', 'item', 'glasses'];
const COLORS = ['stroke', 'hair', 'skin', 'clothes', 'bottom'];
const SIZE = 168;
const TILE_BACKGROUND = '#F1EFE9';
const LOOK = /^(\d{6}-){4}\d{6}_([0-9A-F]{6}-){4}[0-9A-F]{6}_([0-9A-F]{6}|x)$/;
const CACHE_LIMIT = 128;
const cache = new Map();

function signingKey(env) {
  const secret = env.HIVEMIND_EMAIL_AVATAR_SECRET || env.HIVEMIND_CONTROL_PLANE_SESSION_SECRET || env.SESSION_SECRET;
  return secret ? crypto.createHmac('sha256', secret).update(KEY_LABEL).digest() : null;
}

function signature(key, look) {
  return crypto.createHmac('sha256', key).update(look).digest('base64url').slice(0, 22);
}

function encodeLook(appearance) {
  const parts = SLOTS.map(slot => appearance.selections[slot].replace('hm1-p-', '')).join('-');
  const colors = COLORS.map(slot => appearance.colors[slot]).join('-');
  return `${parts}_${colors}_${appearance.background === 'transparent' ? 'x' : appearance.background}`;
}

function decodeLook(look) {
  if (!LOOK.test(look)) return null;
  const [parts, colors, background] = look.split('_');
  const ids = parts.split('-');
  const values = colors.split('-');
  try {
    return validateEmployeeAppearance({
      version: 1, provider: 'humation', template: 'humation-1', asset_version: '1.0.1', seed: 'email', crop: 'avatar',
      selections: Object.fromEntries(SLOTS.map((slot, index) => [slot, `hm1-p-${ids[index]}`])),
      colors: Object.fromEntries(COLORS.map((slot, index) => [slot, values[index]])),
      background: background === 'x' ? 'transparent' : background,
    });
  } catch { // validateEmployeeAppearance throws on a part number outside the Humation 1 manifest; that is a 404.
    return null;
  }
}

/**
 * Signed PNG path for a saved employee appearance.
 * @param {object | null | undefined} saved - `policy_rules.appearance` as stored on the employee.
 * @param {object} [env] - environment holding the signing secret.
 * @returns {string | null} path starting with `/v1/public/employee-avatar/`, or null when the look is invalid or no secret is configured.
 */
export function employeeAvatarPath(saved, env = process.env) {
  const key = signingKey(env);
  let appearance = null;
  try { appearance = validateEmployeeAppearance(saved); } catch { appearance = null; } // An invalid saved look means no image, so the email shows its initial tile.
  if (!key || !appearance) return null;
  const look = encodeLook(appearance);
  return `${EMPLOYEE_AVATAR_PATH}${look}.${signature(key, look)}.png`;
}

/**
 * Absolute avatar URL for an email, or null when the employee has no usable saved look.
 * @param {object | null | undefined} saved - `policy_rules.appearance`.
 * @param {{ env?: object, baseUrl?: string }} [options] - environment and public API origin.
 * @returns {string | null} absolute URL.
 */
export function employeeAvatarUrl(saved, { env = process.env, baseUrl } = {}) {
  const path = employeeAvatarPath(saved, env);
  if (!path) return null;
  return new URL(path, baseUrl || env.HIVEMIND_PUBLIC_API_URL || 'https://api.singulancelabs.com').href;
}

async function renderPng(appearance) {
  const data = createAvatar(humation1, {
    seed: appearance.seed, selections: appearance.selections, colors: appearance.colors, background: appearance.background,
  }).toRenderData();
  const palette = Object.fromEntries(Object.entries(data.colors).map(([slot, color]) => [slot, `#${String(color).replace(/^#/, '')}`]));
  // Some SVG rasterizers ignore CSS custom properties, so bake the palette into every path.
  const content = data.content.replace(/var\(--hm-([a-z0-9_-]+),\s*[^)]+\)/gi, (match, slot) => palette[slot] || match);
  const { x, y, width, height } = data.viewBox;
  const fill = appearance.background === 'transparent' ? TILE_BACKGROUND : `#${appearance.background}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${width} ${height}" width="${SIZE}" height="${SIZE}"><rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fill}"/><g>${content}</g></svg>`;
  const canvas = createCanvas(SIZE, SIZE);
  const context = canvas.getContext('2d');
  context.beginPath();
  context.roundRect(0, 0, SIZE, SIZE, SIZE / 4); // Same 14px-of-56px rounding as the email tile, kept in the pixels for clients that ignore border-radius.
  context.clip();
  context.drawImage(await loadImage(Buffer.from(svg)), 0, 0, SIZE, SIZE);
  return canvas.toBuffer('image/png');
}

/**
 * Verify a request token and render its PNG.
 * @param {string} file - last path segment, `<look>.<signature>.png`.
 * @param {object} [env] - environment holding the signing secret.
 * @returns {Promise<Buffer | null>} PNG bytes, or null when the token is malformed, unsigned or not a Humation 1 look.
 */
export async function renderEmployeeAvatarPng(file, env = process.env) {
  const key = signingKey(env);
  const match = /^([0-9A-Fx_-]{1,120})\.([A-Za-z0-9_-]{22})\.png$/.exec(String(file || ''));
  if (!key || !match) return null;
  const [, look, given] = match;
  const expected = Buffer.from(signature(key, look));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  const appearance = decodeLook(look);
  if (!appearance) return null;
  if (cache.has(look)) return cache.get(look);
  const png = await renderPng(appearance);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(look, png);
  return png;
}
