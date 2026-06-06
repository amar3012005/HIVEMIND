# HiveMind n8n Ingestion — Field Requirements & Guidelines

## Schema Overview

Five top-level objects: **source**, **entity**, **event**, **provenance**, **idempotencyKey**.

The canonical payload is designed for **upsert semantics**: if `idempotencyKey` matches an existing record, merge/update; else create new.

---

## source — Source System Metadata

**Purpose:** Track where the data originated, when it was pulled, and how to link back.

| Field | Type | Required | Constraints & Notes |
|-------|------|----------|---------------------|
| `system` | string | YES | Stable identifier for source system: `salesforce`, `hubspot`, `stripe`, `postgres`, `slack`, `jira`, `linear`, etc. Must be lowercase alphanumeric + underscore. **Used in canonical_id derivation.** |
| `object` | string | NO | Object/entity type in source: `Contact`, `Deal`, `Customer`, `Transaction`, `Issue`, `User`. Helps with classification but not required. |
| `recordId` | string | YES | Primary key in source system. Must be stable across time (not timestamps, not sequential IDs that get reused). **Used in canonical_id derivation.** E.g., `0015g00000XYZ123` (Salesforce) or `5f7c2a1b-9e4d-11ec-81d3-0242ac130003` (UUID). |
| `externalUrl` | string | NO | Deep link to view this record in source UI. Helps users navigate back. E.g., `https://eu1.salesforce.com/0015g00000XYZ123` |
| `pulledAt` | ISO 8601 datetime | YES | When data was extracted. Used as fallback for `idempotencyKey.lastModifiedAt` if source doesn't provide 'updated_at'. **Must have timezone.** E.g., `2026-06-02T14:30:45.123Z` |

**Example:**
```json
{
  "system": "salesforce",
  "object": "Contact",
  "recordId": "0035g00000ABC123",
  "externalUrl": "https://eu1.salesforce.com/0035g00000ABC123",
  "pulledAt": "2026-06-02T14:30:45.123Z"
}
```

---

## entity — Canonical Entity Representation

**Purpose:** Normalize records across systems into a unified entity graph.

| Field | Type | Required | Constraints & Notes |
|-------|------|----------|---------------------|
| `canonicalId` | string (hex or UUID) | YES | Stable deduplication key. **Generate once per (system, recordId) pair and cache.** Use UUID v5 with namespace (recommended for reproducibility) or SHA256(system:recordId)[:64]. Enables cross-system entity matching. Must be deterministic — same (system, recordId) always produces same canonicalId. |
| `type` | string (enum) | YES | Entity type in canonical model: `Person`, `Company`, `Transaction`, `Interaction`, `Document`, `Account`, `Order`, `Opportunity`, `Custom`. Use these; do not invent. Enables federated queries. |
| `name` | string | YES | Display name or primary identifier. For Person: "John Doe". For Company: "ACME Inc". For Transaction: "Invoice #INV-2026-001". Used for UI rendering and human-readable logging. |
| `crossSystemIds` | object | NO | Map of system → IDs for record linkage. **Critical for multi-source deduplication.** E.g., `{"hubspot": "63f5abc123", "slack": "U0ABC123", "zendesk": "id-456"}`. Only include systems where you've confirmed the ID; do not guess. |
| `attributes` | object | NO | Arbitrary flattened attributes. Keys must be snake_case. Values: string, number, boolean, or null. **Do NOT nest objects.** For complex fields, serialize to JSON string. Max 4KB per string. Example: `{"email": "john@acme.com", "phone": "+1234567890", "plan_tier": "enterprise"}` |

**Example:**
```json
{
  "canonicalId": "7a4c3f2e8b1d5a9c6f3e2d1c0a9b8f7e",
  "type": "Person",
  "name": "Jane Smith",
  "crossSystemIds": {
    "salesforce": "0035g00000ABC123",
    "hubspot": "contact-6789",
    "slack": "U0ABC123XYZ"
  },
  "attributes": {
    "email": "jane@acme.com",
    "phone": "+14155551234",
    "company": "ACME Inc",
    "job_title": "VP of Sales",
    "mrr": 2500,
    "is_vip": true,
    "preferred_language": "en"
  }
}
```

---

## event — Event or State Change

**Purpose:** Capture what happened to the entity at a specific moment in time.

| Field | Type | Required | Constraints & Notes |
|-------|------|----------|---------------------|
| `kind` | string (enum) | YES | Event type: `created`, `updated`, `deleted`, `merged`, `status_changed`, `property_changed`, `score_calculated`, `metric_recorded`, `interaction_logged`, `engagement_event`, `custom`. Use existing enums; only use `custom` if none fit. |
| `validAt` | ISO 8601 datetime | YES | **BI-TEMPORAL:** When this event occurred in the real world. NOT when we ingested it. This is the "business time" or "assertion time." E.g., "payment approved at 2026-06-02T10:15Z even though we only pulled it at 15:30Z." Enables time-travel queries. **Must have timezone.** |
| `amount` | number | NO | Optional numeric value for metrics: revenue, score (0-100), quantity, percentage, etc. Precision to 3 decimal places. E.g., `1500.50`, `95.2`, `0`. |
| `narrative` | string | NO | **THE DIFFERENTIATOR.** Free-form text explaining *why* the event occurred or what contextual details matter. This is the single field that distinguishes identical "updated" events in different scenarios. Examples: - "Lead status changed to 'Sales Qualified' because demo was scheduled for 2026-06-15 and discovery call confirmed fit" - "Payment of $1,500 failed due to card expired 2025-08-01; customer notified via email" - "Churn risk score increased from 42 to 78 due to 30 days of inactivity + billing email bounced" Max 2048 chars. Always include if you have it. |
| `reason` | string | NO | Structured reason code for programmatic filtering/dashboarding. All-caps, alphanumeric + underscore. Examples: `INACTIVITY`, `CHURN_SIGNAL`, `SALES_QUALIFIED`, `PAYMENT_FAILED_EXPIRED_CARD`, `UPGRADE_TRIGGERED`. Use consistently within your domain. Enables reason-based metrics and alerts. |
| `tags` | array of strings | NO | Categorical tags for filtering and clustering. Lowercase with hyphens. Examples: `["high-priority", "churn-risk", "vip-upsell"]`. Max 20 tags per event. |
| `metadata` | object | NO | Unstructured metadata. Flattened key-value pairs, similar to attributes. Use only for non-critical context. Example: `{"api_version": "v2", "source_webhook_id": "wh-123", "retry_count": 1}` |

**Example:**
```json
{
  "kind": "status_changed",
  "validAt": "2026-06-02T10:15:00Z",
  "amount": null,
  "narrative": "Lead status changed to 'Sales Qualified' because discovery call on 2026-06-01 confirmed product fit and budget approved by CFO. Next: scheduling demo for 2026-06-15.",
  "reason": "SALES_QUALIFIED",
  "tags": ["hot-lead", "fast-close", "acme-strategic"],
  "metadata": {
    "opportunity_id": "opp-789",
    "sales_rep": "alice@acme.com",
    "notes_character_count": 187
  }
}
```

---

## provenance — Data Provenance & Governance

**Purpose:** Track where data came from, who touched it, PII markings, and retention rules.

| Field | Type | Required | Constraints & Notes |
|-------|------|----------|---------------------|
| `preparer` | string | NO | System/user that transformed the payload. For n8n: the workflow ID, execution ID, or user email. Helps trace back to source of transformation. E.g., `"workflow-abc123"`, `"salesforce-sync-pipeline"`, `"user@company.com"` |
| `channel` | string (enum) | NO | Delivery mechanism: `n8n_webhook`, `n8n_schedule`, `n8n_trigger`, `api_direct`, `batch_import`, `sync_service`, `manual_upload`, `custom`. Helps identify if data is real-time or batch. |
| `touchedAt` | ISO 8601 datetime | YES | **TRANSACTION TIME:** When this record was last modified in HiveMind system. NOT the event time. Generated by HiveMind on upsert. Distinct from `event.validAt`. Used for optimistic locking and audit trails. **Must have timezone.** |
| `piiFlags` | object | NO | GDPR field classification. Keys = field paths (dot notation). Values = boolean (true if PII). E.g., `{"entity.name": true, "entity.attributes.email": true, "entity.attributes.phone": true, "event.narrative": false}`. HiveMind uses this for data masking, GDPR deletion workflows, and access control. |
| `dataClassification` | string (enum) | NO | Sensitivity: `public`, `internal`, `confidential`, `restricted`. Default: `confidential`. Used for access control and audit logging. |
| `consentGiven` | boolean | NO | Has explicit GDPR/privacy consent been obtained for this record? `true` if yes, `false` if no, `null` if unknown. Critical for EU compliance. |
| `retentionDays` | integer | NO | Days to retain before deletion. E.g., `2555` (7 years). If not set, use system default. `null` = indefinite. Used for auto-purge workflows. |
| `version` | integer | NO | Schema version (currently `1`). For backward compatibility if schema evolves. Default: `1`. |

**Example:**
```json
{
  "preparer": "workflow-salesforce-sync-2024",
  "channel": "n8n_webhook",
  "touchedAt": "2026-06-02T14:30:45.123Z",
  "piiFlags": {
    "entity.name": true,
    "entity.attributes.email": true,
    "entity.attributes.phone": true,
    "entity.attributes.company": false,
    "event.narrative": false
  },
  "dataClassification": "confidential",
  "consentGiven": true,
  "retentionDays": 2555,
  "version": 1
}
```

---

## idempotencyKey — Deduplication & Upsert Control

**Purpose:** Ensures replayed payloads don't create duplicates and prevent stale overwrites.

| Field | Type | Required | Constraints & Notes |
|-------|------|----------|---------------------|
| `canonicalId` | string | YES | Must match `entity.canonicalId` exactly. HiveMind checks: if this ID exists + `lastModifiedAt` > stored `lastModifiedAt`, update; if `lastModifiedAt` <= stored, skip (ignore stale); if ID doesn't exist, create. Prevents stale replays from rolling back fresh updates. |
| `lastModifiedAt` | ISO 8601 datetime | YES | Timestamp from source system (when the record was last changed there). Usually `source.pulledAt` or a source-provided `updated_at` field. If incoming `lastModifiedAt` ≤ stored `lastModifiedAt`, HiveMind skips the update. Enables safe webhook retries. **Must have timezone.** |

**Example:**
```json
{
  "canonicalId": "7a4c3f2e8b1d5a9c6f3e2d1c0a9b8f7e",
  "lastModifiedAt": "2026-06-02T14:30:45.123Z"
}
```

---

## Full Payload Example

```json
{
  "source": {
    "system": "salesforce",
    "object": "Contact",
    "recordId": "0035g00000ABC123",
    "externalUrl": "https://eu1.salesforce.com/0035g00000ABC123",
    "pulledAt": "2026-06-02T14:30:45.123Z"
  },
  "entity": {
    "canonicalId": "7a4c3f2e8b1d5a9c6f3e2d1c0a9b8f7e",
    "type": "Person",
    "name": "Jane Smith",
    "crossSystemIds": {
      "salesforce": "0035g00000ABC123",
      "hubspot": "contact-6789",
      "slack": "U0ABC123XYZ"
    },
    "attributes": {
      "email": "jane@acme.com",
      "phone": "+14155551234",
      "company": "ACME Inc",
      "job_title": "VP of Sales",
      "mrr": 2500,
      "is_vip": true
    }
  },
  "event": {
    "kind": "status_changed",
    "validAt": "2026-06-02T10:15:00Z",
    "amount": null,
    "narrative": "Lead promoted to Sales Qualified: discovery call confirmed product fit, CFO approved $50k budget allocation, signed NDA. Demo scheduled 2026-06-15.",
    "reason": "SALES_QUALIFIED",
    "tags": ["hot-lead", "vip-account"],
    "metadata": {
      "sales_rep": "alice@acme.com",
      "opportunity_value": 50000
    }
  },
  "provenance": {
    "preparer": "workflow-salesforce-sync",
    "channel": "n8n_webhook",
    "touchedAt": "2026-06-02T14:30:45.123Z",
    "piiFlags": {
      "entity.name": true,
      "entity.attributes.email": true,
      "entity.attributes.phone": true,
      "event.narrative": false
    },
    "dataClassification": "confidential",
    "consentGiven": true,
    "retentionDays": 2555,
    "version": 1
  },
  "idempotencyKey": {
    "canonicalId": "7a4c3f2e8b1d5a9c6f3e2d1c0a9b8f7e",
    "lastModifiedAt": "2026-06-02T14:30:45.123Z"
  }
}
```

---

## Implementation Checklist for n8n Workflows

- [ ] Compute `canonicalId` deterministically (UUID v5 or SHA256) and cache in external state to ensure stability
- [ ] Populate `narrative` with every event — this is the differentiator; never leave it null
- [ ] Use structured `reason` codes consistently within your domain
- [ ] Always tag PII fields in `piiFlags` for GDPR compliance
- [ ] Set `consentGiven` based on user consent records or leave null if unknown
- [ ] Use ISO 8601 with timezone on ALL datetime fields (UTC preferred: `Z` suffix)
- [ ] Validate payload against this schema before sending to HiveMind
- [ ] Handle 409 conflict and 400 validation errors gracefully (retry logic)
- [ ] Log full payload on error for debugging

