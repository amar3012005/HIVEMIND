/**
 * Connector manifest registry.
 *
 * One manifest per connector. Single source of truth for:
 *   - tier1_sync: which fields land in thin index, sync frequency
 *   - webhook: which provider events stream into HIVEMIND
 *   - tier2_promote: rules to lazy-hydrate a Tier 1 row → Tier 2 (full body)
 *   - tier3_live: which live tools (MCP/Nango) the agent can call on recall miss
 *
 * Designed to be JSON-loaded so adding a new connector = drop a manifest
 * file + adapter, no SyncEngine code changes.
 *
 * Manifest schema:
 * {
 *   provider: 'gmail',
 *   tier1_sync: {
 *     enabled: true,
 *     frequency_minutes: 60,
 *     fields: ['id','threadId','subject','from','to','snippet','date'],
 *     summary_field: 'snippet',          // populates Memory.content for Tier 1
 *     title_template: 'Email: {subject}',
 *     anchor_tag_prefix: 'thread'        // emits tag thread:<threadId>
 *   },
 *   webhook: {
 *     enabled: true,
 *     events: ['message.new', 'message.label_changed'],
 *     handler_path: '/api/connectors/gmail/webhook'
 *   },
 *   tier2_promote: {
 *     triggers: [
 *       { type: 'recall_hit', min_score: 0.6 },
 *       { type: 'entity_in_workingset' },
 *       { type: 'thread_in_workingset' },
 *       { type: 'explicit_user_save' }
 *     ],
 *     hydrate_tool: 'gmail_read_message',  // tool name in connector-toolkit
 *     hydrate_input_from: 'source_id'      // memory.source_metadata.source_id
 *   },
 *   tier3_live: {
 *     tools: ['gmail_search_messages','gmail_read_message','gmail_send_email','gmail_label_message']
 *   }
 * }
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MANIFEST_DIR = path.resolve(__dirname, '../../../data/connector-manifests');

let _cache = null;

function loadAll() {
  if (_cache) return _cache;
  _cache = new Map();
  if (!fs.existsSync(MANIFEST_DIR)) return _cache;
  for (const file of fs.readdirSync(MANIFEST_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(MANIFEST_DIR, file), 'utf8');
      const m = JSON.parse(raw);
      if (m && m.provider) _cache.set(m.provider, m);
    } catch (err) {
      console.warn(`[connector-manifest] failed to load ${file}: ${err.message}`);
    }
  }
  return _cache;
}

export function getManifest(provider) {
  if (!provider) return null;
  return loadAll().get(provider) || null;
}

export function listManifests() {
  return Array.from(loadAll().values());
}

export function isThinIndexEnabled(provider) {
  const m = getManifest(provider);
  return !!(m?.tier1_sync?.enabled);
}

export function getTier3Tools(provider) {
  const m = getManifest(provider);
  return m?.tier3_live?.tools || [];
}

export function getHydrateConfig(provider) {
  const m = getManifest(provider);
  if (!m?.tier2_promote) return null;
  return {
    tool: m.tier2_promote.hydrate_tool || null,
    inputFrom: m.tier2_promote.hydrate_input_from || 'source_id',
  };
}

export function _invalidateCache() {
  _cache = null;
}
