/**
 * TARA Routes — Register all /api/tara/* endpoints
 */

export const TARA_ROUTE_PREFIXES = [
  '/api/tara/stream',
  '/api/tara/config',
  '/api/tara/sessions',
];

export function isTaraRoute(pathname) {
  return pathname.startsWith('/api/tara/');
}
