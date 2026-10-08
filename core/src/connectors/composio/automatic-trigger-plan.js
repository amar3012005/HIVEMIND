// Provider schemas decide what can be subscribed without inventing resource IDs.
export function automaticTriggerPlan(types, account, existing, normalize, validate) {
  return types.map(type => {
    const base = { accountId: account.id, slug: type.slug, version: type.version };
    if (!type.slug || type.toolkit?.slug !== account.toolkit) return { ...base, status: 'wrong_toolkit' };
    if (/\bdeprecated\b/i.test(type.description || '')) return { ...base, status: 'deprecated' };
    if (existing.some(row => row.account_id === account.id && row.slug === type.slug && (['paused', 'deleted'].includes(row.status) || row.runtime_attention_opt_out === true))) return { ...base, status: 'disabled_by_user' };
    if (type.requires_webhook_endpoint_setup && account.managedAuth !== true) return { ...base, status: 'provider_setup_required' };
    if (!type.version) return { ...base, status: 'schema_version_missing' };
    const configSchema = normalize(type.config);
    const config = Object.fromEntries(Object.entries(configSchema.properties || {}).filter(([, field]) => field.default !== undefined).map(([key, field]) => [key, field.default]));
    if (!validate(configSchema, config)) return { ...base, status: 'resource_configuration_required', required: configSchema.required || [] };
    return { ...base, status: 'ready', config };
  });
}
