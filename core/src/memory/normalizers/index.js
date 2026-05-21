// Provider normalizer registry. Each entry strips the platform-specific
// noise from a raw payload (signatures, headers, mention syntax, HTML)
// and returns a clean { content, metadata } pair that the bucket router
// can chunk + tree-ify uniformly.
//
// Adding a new connector = one new file in this directory + one line
// here. The bucket router never needs to know the provider list.
//
// Contract:
//   normalize(content, metadata) → { content, metadata }
//
// `metadata` returned may carry structured fields the bucket router can
// promote (e.g. email_from, slack_user, github_pr_number) — those land
// on the parent memory's metadata for retrieval.
import { gmail } from './gmail.js';
import { slack } from './slack.js';
import { github } from './github.js';
import { drive } from './drive.js';
import { defaultNormalizer } from './default.js';

export const NORMALIZERS = {
  gmail,
  slack,
  github,
  google_drive: drive,
  google_docs: drive,
  google_sheets: drive,
  google_slides: drive,
  knowledge_base: defaultNormalizer,
  chat: defaultNormalizer,
  'talk-to-hive': defaultNormalizer,
  manual: defaultNormalizer,
  // Unknown providers fall through to the default no-op normalizer.
};

export function getNormalizer(provider) {
  return NORMALIZERS[provider] || defaultNormalizer;
}

/**
 * Detect which of the four canonical buckets a payload belongs to.
 * One place to update when adding a new connector — the router itself
 * stays unchanged.
 *
 * Buckets:
 *   document_ingest  — uploaded/extracted documents (KB, drive, pdf, web)
 *   conversation     — multi-turn dialogue (chat, gmail thread, slack thread)
 *   connector_event  — single external record (issue, calendar event, deal)
 *   standalone       — atomic fact (MCP save_memory, manual /api/memories)
 */
export function detectBucket(payload) {
  // Explicit hint always wins.
  if (payload?.bucket_hint && ['document_ingest', 'conversation', 'connector_event', 'standalone'].includes(payload.bucket_hint)) {
    return payload.bucket_hint;
  }
  const platform = (
    payload?.source_metadata?.source_platform
    || payload?.source_metadata?.source_type
    || payload?.metadata?.source_platform
    || payload?.ingest_type
    || ''
  ).toLowerCase();

  if (!platform) return 'standalone';

  // Documents
  if (
    platform.includes('knowledge') ||
    platform.includes('document') ||
    platform.includes('pdf') ||
    platform.includes('notion') ||
    platform.includes('obsidian') ||
    platform.includes('google_drive') ||
    platform.includes('google_docs') ||
    platform.includes('google_sheets') ||
    platform.includes('google_slides') ||
    platform.includes('web_crawl') ||
    platform.includes('webpage')
  ) return 'document_ingest';

  // Conversations
  if (
    platform.includes('gmail') ||
    platform.includes('email') ||
    platform.includes('slack') ||
    platform.includes('teams') ||
    platform.includes('discord') ||
    platform.includes('chat') ||
    platform.includes('talk-to-hive') ||
    platform.includes('claude') ||
    platform.includes('anthropic') ||
    platform.includes('conversation')
  ) return 'conversation';

  // Connector events
  if (
    platform.includes('github') ||
    platform.includes('gitlab') ||
    platform.includes('linear') ||
    platform.includes('jira') ||
    platform.includes('atlassian') ||
    platform.includes('salesforce') ||
    platform.includes('hubspot') ||
    platform.includes('calendar')
  ) return 'connector_event';

  return 'standalone';
}
