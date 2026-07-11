const ipv4 = (host) => host.split('.').map(Number);

export function normalizeAgentUrl(value, { allowLocal = false } = {}) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (allowLocal && raw === 'local:') return raw;
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid agent URL'); }
  if (url.username || url.password || url.hash) throw new Error('Agent URL cannot contain credentials or fragments');
  if (url.pathname !== '/' || url.search) throw new Error('Agent URL must not contain a path or query');

  const host = url.hostname.toLowerCase();
  const octets = ipv4(host);
  const tailscale = host.endsWith('.ts.net')
    || (octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
  const privateHost = host === 'localhost' || host === '::1'
    || octets[0] === 0 || octets[0] === 10 || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);

  if (url.protocol === 'http:' && !tailscale) throw new Error('HTTP agent URLs require Tailscale');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Agent URL must use HTTPS or Tailscale HTTP');
  if (privateHost && !tailscale) throw new Error('Private or link-local agent URL is forbidden');
  return url.origin;
}
