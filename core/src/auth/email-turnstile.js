const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN_LENGTH = 2048;

function expectedHostnames(value) {
  return new Set(String(value || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
}

export async function verifyEmailTurnstile({ token, remoteIp, env = process.env, fetchImpl = fetch }) {
  if (env.HIVEMIND_LOCAL_MODE === 'true' && env.EMAIL_AUTH_TURNSTILE_BYPASS === 'true') return true;

  const secret = String(env.TURNSTILE_EMAIL_AUTH_SECRET || '').trim();
  const responseToken = String(token || '').trim();
  const hostnames = expectedHostnames(env.TURNSTILE_EMAIL_AUTH_HOSTNAMES);
  if (!secret || !responseToken || responseToken.length > MAX_TOKEN_LENGTH || hostnames.size === 0) return false;

  const form = new FormData();
  form.set('secret', secret);
  form.set('response', responseToken);
  if (remoteIp) form.set('remoteip', String(remoteIp));

  try {
    const response = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return false;
    const result = await response.json();
    return Boolean(
      result?.success === true
      && result.action === 'email_auth'
      && hostnames.has(String(result.hostname || '').toLowerCase()),
    );
  } catch {
    return false;
  }
}

