import { RuntimeAdapterRegistry } from '../adapter-registry.js';
import { createGmailRuntimeAdapter } from './gmail.js';
import { createTenantRecordsAdapter } from './tenant-records.js';

export function createProductionRuntimeAdapterRegistry({ prisma } = {}) {
  const registry = new RuntimeAdapterRegistry();
  registry.register(createTenantRecordsAdapter({ prisma }));
  registry.register(createGmailRuntimeAdapter({ prisma }));
  return registry;
}
