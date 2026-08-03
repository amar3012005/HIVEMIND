import { RuntimeAdapterRegistry } from '../adapter-registry.js';
import { createGmailRuntimeAdapter } from './gmail.js';
import { createTenantRecordsAdapter } from './tenant-records.js';
import { createCampaignRuntimeAdapter } from './campaigns.js';
import { createTaraOutreachRuntimeAdapter } from './tara-outreach.js';

export function createProductionRuntimeAdapterRegistry({ prisma } = {}) {
  const registry = new RuntimeAdapterRegistry();
  registry.register(createTenantRecordsAdapter({ prisma }));
  registry.register(createGmailRuntimeAdapter({ prisma }));
  registry.register(createCampaignRuntimeAdapter({ prisma }));
  registry.register(createTaraOutreachRuntimeAdapter({ prisma }));
  return registry;
}
