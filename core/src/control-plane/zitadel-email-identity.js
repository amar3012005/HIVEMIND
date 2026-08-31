import crypto from 'node:crypto';

export async function createZitadelEmailIdentity(email) {
  const baseUrl = String(process.env.ZITADEL_API_URL || process.env.ZITADEL_ISSUER_URL || '').replace(/\/$/, '');
  const token = String(process.env.ZITADEL_SERVICE_PAT || '');
  const orgId = String(process.env.ZITADEL_EMAIL_ORG_ID || '');
  if (!baseUrl || !token || !orgId) throw new Error('ZITADEL email identity provisioning is not configured');
  const localPart = email.split('@')[0].replace(/[^a-z0-9._-]/gi, '').slice(0, 48) || 'member';
  const response = await fetch(`${baseUrl}/v2/users/human`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      username: `${localPart}-${crypto.randomUUID().slice(0, 8)}`,
      organization: { orgId },
      profile: { givenName: localPart, familyName: 'Member', displayName: localPart },
      email: { email, isVerified: true },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`ZITADEL identity provisioning failed (${response.status})`);
  const userId = payload.userId || payload.id || payload.user?.id;
  if (!userId) throw new Error('ZITADEL identity provisioning returned no user id');
  return { userId: String(userId), displayName: localPart };
}
