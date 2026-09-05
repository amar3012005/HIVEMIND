export type NativeMetaFlagEnv = {
  NATIVE_META_TOOLS_ENABLED: 'true' | 'false';
  NATIVE_META_FLAG?: string;
  ENVIRONMENT: string;
  FLAGS: {
    getBooleanDetails(key: string, fallback: boolean, context?: Record<string, string | number | boolean>): Promise<{ value: boolean }>;
  };
};

export async function evaluateNativeMetaMode(
  env: NativeMetaFlagEnv,
  url: URL,
): Promise<'off' | 'native-meta-v1'> {
  const orgId = url.searchParams.get('org_id') || '';
  const userId = url.searchParams.get('user_id') || '';
  if (env.NATIVE_META_TOOLS_ENABLED !== 'true' || !orgId || !userId) return 'off';
  try {
    const details = await env.FLAGS.getBooleanDetails(
      env.NATIVE_META_FLAG || 'hivemind-native-meta-tools-v1',
      false,
      { targetingKey: `${orgId}:${userId}`, org_id: orgId, user_id: userId, environment: env.ENVIRONMENT },
    );
    return details.value === true ? 'native-meta-v1' : 'off';
  } catch { return 'off'; }
}
