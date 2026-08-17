export function assertTenantOrg(requestedOrg, contextOrg) {
  if (contextOrg && requestedOrg && String(contextOrg) !== String(requestedOrg)) {
    const error = new Error('tenant scope mismatch');
    error.code = 'TENANT_SCOPE_MISMATCH';
    throw error;
  }
  return contextOrg || requestedOrg || null;
}

export function enforceTenantFilter(filter, contextOrg) {
  if (!contextOrg) return filter;
  const must = Array.isArray(filter?.must) ? filter.must : [];
  const declared = must
    .filter((clause) => clause?.key === 'org_id')
    .map((clause) => clause?.match?.value)
    .filter(Boolean);
  for (const org of declared) assertTenantOrg(org, contextOrg);
  if (declared.length > 0) return filter;
  return { ...(filter || {}), must: [...must, { key: 'org_id', match: { value: contextOrg } }] };
}
