export type NativeMetaFlagEnv = {
  NATIVE_META_TOOLS_ENABLED: 'true' | 'false';
  NATIVE_META_FLAG?: string;
  ENVIRONMENT: string;
  FLAGS: {
    getBooleanDetails(key: string, fallback: boolean, context?: Record<string, string | number | boolean>): Promise<{ value: boolean }>;
    getStringDetails?(key: string, fallback: string, context?: Record<string, string | number | boolean>): Promise<{ value: string }>;
  };
};

export async function evaluateNativeMetaMode(
  env: NativeMetaFlagEnv,
  url: URL,
): Promise<'off' | 'native-meta-v1' | 'unified-meta-v2'> {
  const orgId = url.searchParams.get('org_id') || '';
  const userId = url.searchParams.get('user_id') || '';
  if (env.NATIVE_META_TOOLS_ENABLED !== 'true' || !orgId || !userId) return 'off';
  try {
    const context = { targetingKey: `${orgId}:${userId}`, org_id: orgId, user_id: userId, environment: env.ENVIRONMENT };
    // A string flag can canary the unified graph without changing the legacy
    // boolean flag. Unknown values fail closed.
    if (typeof env.FLAGS.getStringDetails === 'function') {
      const details = await env.FLAGS.getStringDetails(
        env.NATIVE_META_FLAG || 'hivemind-native-meta-tools-v1',
        'off',
        context,
      );
      if (details.value === 'unified-meta-v2' || details.value === 'native-meta-v1') return details.value;
      return 'off';
    }
    const details = await env.FLAGS.getBooleanDetails(
      env.NATIVE_META_FLAG || 'hivemind-native-meta-tools-v1',
      false,
      context,
    );
    return details.value === true ? 'native-meta-v1' : 'off';
  } catch { return 'off'; }
}
