import { RuntimeAdapterRegistry } from '../adapter-registry.js';
import { createGmailRuntimeAdapter } from './gmail.js';
import { createTenantRecordsAdapter } from './tenant-records.js';
import { createCampaignRuntimeAdapter } from './campaigns.js';

export function createProductionRuntimeAdapterRegistry({ prisma } = {}) {
  const registry = new RuntimeAdapterRegistry();
  registry.register(createTenantRecordsAdapter({ prisma }));
  registry.register(createGmailRuntimeAdapter({ prisma }));
  registry.register(createCampaignRuntimeAdapter({ prisma }));
  return registry;
}
