import { RuntimeAdapterRegistry } from '../adapter-registry.js';
import { createGmailRuntimeAdapter } from './gmail.js';
import { createTenantRecordsAdapter } from './tenant-records.js';
import { createCampaignRuntimeAdapter } from './campaigns.js';
import { createTaraOutreachRuntimeAdapter } from './tara-outreach.js';
import { createRuntimeInputAdapter } from './runtime-input.js';
import { createChildPlaybookAdapter } from './child-playbook.js';
import { createRuntimeJournalAdapter } from './runtime-journal.js';
import { createLeadTimelineAdapter } from './lead-timeline.js';
import { createBrowserAdminCheckinAdapter } from './browser-admin-checkin.js';

export function createProductionRuntimeAdapterRegistry({ prisma, getService = () => null } = {}) {
  const registry = new RuntimeAdapterRegistry();
  registry.register(createTenantRecordsAdapter({ prisma }));
  registry.register(createGmailRuntimeAdapter({ prisma }));
  registry.register(createCampaignRuntimeAdapter({ prisma }));
  registry.register(createTaraOutreachRuntimeAdapter({ prisma }));
  registry.register(createRuntimeInputAdapter());
  registry.register(createChildPlaybookAdapter({ prisma, getService }));
  registry.register(createRuntimeJournalAdapter({ prisma }));
  registry.register(createLeadTimelineAdapter({ prisma }));
  registry.register(createBrowserAdminCheckinAdapter());
  return registry;
}
