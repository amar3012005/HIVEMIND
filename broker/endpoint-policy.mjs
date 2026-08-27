import net from 'node:net';
import dns from 'node:dns/promises';
import { memoryBoxHostname } from './cloudflare-tunnel.mjs';

export function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8')
      || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') || value.startsWith('::ffff:127.')
      || value.startsWith('::ffff:10.') || value.startsWith('::ffff:192.168.');
  }
  return true;
}

export async function validateEndpoint(value, transport, orgId, expected = null, lookup = dns.lookup) {
  try {
    if (!value || String(value).length > 500) return false;
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) return false;
    const hostname = url.hostname.toLowerCase();
    if (transport === 'cloudflare') {
      return url.protocol === 'https:' && !url.port && hostname === memoryBoxHostname(orgId)
        && (!expected || url.origin === new URL(expected).origin);
    }
    if (transport === 'tailscale') return ['http:', 'https:'].includes(url.protocol) && hostname.endsWith('.ts.net');
    if (transport !== 'custom_https' || url.protocol !== 'https:') return false;
    if (hostname === 'localhost' || (net.isIP(hostname) && isPrivateAddress(hostname))) return false;
    const resolved = await lookup(hostname, { all: true, verbatim: true });
    return resolved.length > 0 && resolved.every(({ address }) => !isPrivateAddress(address));
  } catch { return false; }
}
