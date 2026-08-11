const CAPABILITY = 'outbound_voice_call';
const GOOD_TTL_MS = 5 * 60 * 1000;
const PROTECTION_MS = 15 * 60 * 1000;
const NEGATIVE_LIMIT = 2;

function baseUrl(provider) {
  return provider === 'grok'
    ? (process.env.HIVEMIND_TARA_GROK_URL || process.env.TARA_GROK_INTERNAL_URL || 'http://tara-grok:8092')
    : (process.env.HIVEMIND_TARA_DEEPGRAM_URL || 'http://tara-deepgram:8091');
}

function configuredOrder(runtime) {
  const preferred = runtime?.defaultProvider === 'grok' ? 'grok' : 'deepgram';
  const configured = [runtime?.deepgramConfig, runtime?.grokConfig]
    .flatMap((value) => Array.isArray(value?.provider_order) ? value.provider_order : [])
    .map(String).filter((value) => ['deepgram', 'grok'].includes(value));
  return [...new Set([preferred, ...configured, preferred === 'grok' ? 'deepgram' : 'grok'])];
}

async function probe(fetchImpl, url) {
  try {
    const response = await fetchImpl(`${url.replace(/\/$/, '')}/capabilities`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return { available: false, reason: `http_${response.status}` };
    const body = await response.json().catch(() => ({}));
    return { available: body?.telephony !== false, reason: body?.telephony === false ? 'telephony_unavailable' : null };
  } catch (error) {
    return { available: false, reason: String(error?.code || error?.message || 'probe_failed').slice(0, 200) };
  }
}

export async function resolveTaraProviderCandidates({ prisma, orgId, fetchImpl = fetch } = {}) {
  const runtime = await prisma.taraRuntimeConfig.findUnique({ where: { orgId } });
  if (!runtime) return { selected: null, candidates: [], rejected: [{ provider: null, reason: 'tara_runtime_missing' }] };
  const now = new Date();
  const candidates = [];
  const rejected = [];
  for (const provider of configuredOrder(runtime)) {
    const existing = await prisma.capabilityAdapterState.findUnique({
      where: { orgId_capabilityKey_adapterId: { orgId, capabilityKey: CAPABILITY, adapterId: provider } },
    }).catch(() => null);
    let result;
    if (existing?.state === 'AVAILABLE' && existing.expiresAt > now) {
      result = { available: true, reason: null, cached: true };
    } else {
      result = await probe(fetchImpl, baseUrl(provider));
      const negatives = result.available ? 0 : Number(existing?.consecutiveNegatives || 0) + 1;
      const protectedGood = !result.available && negatives < NEGATIVE_LIMIT
        && existing?.lastGoodAt && now.getTime() - existing.lastGoodAt.getTime() < PROTECTION_MS;
      const effectiveAvailable = result.available || protectedGood;
      await prisma.capabilityAdapterState.upsert({
        where: { orgId_capabilityKey_adapterId: { orgId, capabilityKey: CAPABILITY, adapterId: provider } },
        create: {
          orgId, capabilityKey: CAPABILITY, adapterId: provider,
          state: effectiveAvailable ? 'AVAILABLE' : 'UNAVAILABLE', consecutiveNegatives: negatives,
          lastGoodAt: result.available ? now : null, lastCheckedAt: now,
          expiresAt: new Date(now.getTime() + GOOD_TTL_MS),
          metadata: { reason: result.reason, protected_good: protectedGood },
        },
        update: {
          state: effectiveAvailable ? 'AVAILABLE' : 'UNAVAILABLE', consecutiveNegatives: negatives,
          ...(result.available ? { lastGoodAt: now } : {}), lastCheckedAt: now,
          expiresAt: new Date(now.getTime() + GOOD_TTL_MS),
          metadata: { reason: result.reason, protected_good: protectedGood },
        },
      });
      result.available = effectiveAvailable;
    }
    const descriptor = { provider, baseUrl: baseUrl(provider), revision: runtime.revision || 1 };
    if (result.available) candidates.push(descriptor);
    else rejected.push({ provider, reason: result.reason || 'unavailable' });
  }
  return { selected: candidates[0] || null, candidates, rejected };
}
