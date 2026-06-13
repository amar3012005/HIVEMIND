/**
 * Gmail connector schemas (zod).
 *
 * Single source of truth for the SHAPE of a Gmail `sync_config` and the
 * normalized memory payload. Validate untrusted input (the sync modal body,
 * persisted connector metadata) at the boundary so a malformed config can't
 * silently produce the firehose or a broken Gmail query.
 */

import { z } from 'zod';

/** Allowed Gmail category facets for `exclude_categories`. */
export const GMAIL_CATEGORIES = ['promotions', 'social', 'updates', 'forums'];

/** Allowed `date_range` presets. */
export const DATE_RANGES = ['7d', '30d', '90d', '365d', 'all'];

/**
 * `sync_config` — what the modal sends and what is persisted to
 * connectorMetadata.sync_config, replayed by the scheduler on every tick.
 * Unknown keys are stripped (`.strip()` default) so stray fields never leak
 * into the Gmail query builder.
 */
export const SyncConfigSchema = z.object({
  date_range: z.enum(DATE_RANGES).default('30d'),
  folders: z.array(z.string()).default(['INBOX', 'SENT']),
  exclude_categories: z.array(z.enum(GMAIL_CATEGORIES)).default([]),
  include_keywords: z.array(z.string()).optional(),
  exclude_keywords: z.array(z.string()).optional(),
  include_only_sent: z.boolean().optional(),
  exclude_chats: z.boolean().optional(),
  include_only_with_attachments: z.boolean().optional(),
  block_senders: z.array(z.string()).default([]),
  disable_default_blocklist: z.boolean().optional(),
  max_emails: z.number().int().positive().max(5000).default(500),
});

/** Source metadata persisted with every Gmail memory (idempotency key lives here). */
export const GmailSourceMetadataSchema = z.object({
  source_type: z.literal('gmail'),
  source_platform: z.literal('gmail'),
  source_id: z.string(),
  thread_id: z.string().optional().nullable(),
  parent_message_id: z.string().optional().nullable(),
});

/** The normalized memory payload the adapter hands to the sync engine. */
export const MemoryPayloadSchema = z.object({
  user_id: z.string(),
  org_id: z.string().nullable().optional(),
  project: z.string().nullable().optional(),
  content: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
  memory_type: z.literal('event'),
  skipProcessing: z.boolean().optional(),
  document_date: z.string().nullable().optional(),
  event_dates: z.array(z.string()).optional(),
  source_metadata: GmailSourceMetadataSchema,
  metadata: z.record(z.string(), z.unknown()),
  relationship: z.object({ type: z.string(), related_to: z.unknown().nullable() }).optional(),
  skip_relationship_classification: z.boolean().optional(),
});

/**
 * Parse + normalize a raw sync_config body. Returns the validated config with
 * defaults applied. Throws ZodError on invalid input — callers should catch
 * and surface a 400.
 * @param {unknown} raw
 * @returns {z.infer<typeof SyncConfigSchema>}
 */
export function parseSyncConfig(raw) {
  return SyncConfigSchema.parse(raw ?? {});
}

/**
 * Non-throwing variant — returns { success, data | error }. Use when a bad
 * persisted config should degrade to defaults rather than fail the sync.
 * @param {unknown} raw
 */
export function safeParseSyncConfig(raw) {
  return SyncConfigSchema.safeParse(raw ?? {});
}
