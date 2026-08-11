const VALID_RUNTIME_CONNECTOR_PROVIDERS = new Set(['composio', 'nango']);

const COMPOSIO_TOOLKIT_ALIASES = Object.freeze({
  gmail: 'gmail',
  'google-mail': 'gmail',
  'google-docs': 'googledocs',
  google_docs: 'googledocs',
  'google-drive': 'googledrive',
  google_drive: 'googledrive',
  notion: 'notion',
  github: 'github',
  linear: 'linear',
});

export function getHyperagentsRuntimeConnectorProvider(env = process.env) {
  const configured = String(env.HYPERAGENTS_RUNTIME_CONNECTORS || 'nango').trim().toLowerCase();
  return VALID_RUNTIME_CONNECTOR_PROVIDERS.has(configured) ? configured : 'nango';
}

export function toComposioToolkit(capability) {
  const normalized = String(capability || '').trim().toLowerCase();
  return COMPOSIO_TOOLKIT_ALIASES[normalized] || normalized.replaceAll('_', '');
}

export function runtimeConnectorConnectPath(capability, provider = getHyperagentsRuntimeConnectorProvider()) {
  const canonical = String(capability || '').trim().toLowerCase();
  const params = new URLSearchParams({ connect: canonical, runtime_connector_provider: provider });
  if (provider === 'composio') params.set('composio_toolkit', toComposioToolkit(canonical));
  return `/hivemind/app/connectors?${params.toString()}`;
}

export async function listRuntimeConnectedCapabilities({ prisma, orgId, userId, provider = getHyperagentsRuntimeConnectorProvider() }) {
  if (provider === 'composio') {
    const { listConnectedAccounts } = await import('./composio/composio-service.js');
    const rows = await listConnectedAccounts(orgId).catch(() => []);
    return rows.filter((row) => row.status === 'ACTIVE').map((row) => String(row.toolkit || '').toLowerCase());
  }
  if (!prisma?.nangoConnection) return [];
  const rows = await prisma.nangoConnection.findMany({
    where: { orgId, ...(userId ? { userId } : {}), status: 'active' },
    select: { providerKey: true },
  }).catch(() => []);
  return rows.map((row) => String(row.providerKey || '').toLowerCase());
}

export { VALID_RUNTIME_CONNECTOR_PROVIDERS };
