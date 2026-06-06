# HiveMind n8n Ingestion — Implementation Notes

## Files in This Directory

1. **hivemind_n8n_schema.json** — JSON Schema v7 defining the canonical payload structure
2. **hivemind_n8n_field_requirements.md** — Detailed field-by-field requirements, constraints, and examples
3. **IMPLEMENTATION_NOTES.md** — This file

## Key Design Decisions

### 1. Bi-Temporal Tracking

The schema enforces **event time** (when something happened) vs **transaction time** (when we recorded it):

- `event.validAt`: Business time — when the event actually occurred
- `provenance.touchedAt`: Transaction time — when HiveMind recorded it

This enables "time-travel" queries: "What was Jane's status as of 2026-05-15?" vs "What do we know about Jane now?"

### 2. Narrative as Differentiator

Many events are structurally identical (e.g., `status_changed` from 100 different leads). The `event.narrative` field is the single differentiator:

- "Lead qualified because budget approved by CFO"
- "Lead qualified because competitor's contract expired"
- "Lead qualified because trial activation exceeded threshold"

Same event kind, completely different context. **Never leave narrative null.**

### 3. Canonical ID for Deduplication

`entity.canonicalId` is deterministic and stable:

```
canonicalId = SHA256("salesforce:0035g00000ABC123")[:64]
or
canonicalId = UUID v5(namespace="urn:hivemind:system", name="salesforce:0035g00000ABC123")
```

Same (system, recordId) always produces the same canonicalId. This enables cross-system entity matching without pre-sync coordination.

### 4. Idempotent Upserts

Two-part idempotency key:

1. `canonicalId` — matches or creates entity
2. `lastModifiedAt` — if incoming ≤ stored, skip update (prevents stale replays)

This ensures:
- Webhook retries don't create duplicates
- Out-of-order deliveries don't roll back fresh data
- Safe retry semantics without coordination

### 5. PII Governance Built-In

`provenance.piiFlags` flags every field containing PII:

```json
{
  "entity.name": true,
  "entity.attributes.email": true,
  "event.narrative": false
}
```

HiveMind uses this to:
- Mask PII in logs and audit trails
- Enforce GDPR deletion (right to be forgotten)
- Apply field-level access control
- Generate compliance reports

### 6. Reason Codes + Narrative Complement

- `event.reason`: Structured code (`SALES_QUALIFIED`, `CHURN_SIGNAL`) for dashboards and alerts
- `event.narrative`: Free-form explanation of why

Both are optional but reason codes enable dashboarding; narrative enables human understanding.

## n8n Workflow Patterns

### Computing Canonical ID (Once, Cached)

```javascript
// In n8n workflow, use a database or cache (Redis) to store computed IDs
const system = "salesforce";
const recordId = "0035g00000ABC123";

// On first encounter:
const crypto = require("crypto");
const canonicalId = crypto
  .createHash("sha256")
  .update(`${system}:${recordId}`)
  .digest("hex")
  .slice(0, 64);

// Cache in external DB so replayed workflows always use same ID
```

### Building Narrative Dynamically

```javascript
const narrative = [
  `Contact status changed to '${newStatus}'`,
  `because ${reason}`,
  `on ${eventDate}`,
  contact.description ? `; notes: ${contact.description}` : ""
].join("");
```

### Validating Before Send

Use a "Code" node with JSON Schema validation before POST:

```javascript
const Ajv = require("ajv");
const ajv = new Ajv();
const schema = require("/path/to/hivemind_n8n_schema.json");
const validate = ajv.compile(schema);

if (!validate(payload)) {
  throw new Error(`Validation failed: ${JSON.stringify(validate.errors)}`);
}
```

## Mapping Source Systems

### Salesforce Contact

```json
{
  "source": {
    "system": "salesforce",
    "object": "Contact",
    "recordId": "{{ $node.Salesforce.data.Id }}",
    "externalUrl": "https://{{ env.SALESFORCE_INSTANCE }}.salesforce.com/{{ $node.Salesforce.data.Id }}",
    "pulledAt": "{{ now.toISOString() }}"
  },
  "entity": {
    "canonicalId": "{{ $node.ComputeID.data.canonicalId }}",
    "type": "Person",
    "name": "{{ $node.Salesforce.data.FirstName }} {{ $node.Salesforce.data.LastName }}",
    "crossSystemIds": {
      "salesforce": "{{ $node.Salesforce.data.Id }}",
      "hubspot": "{{ $node.GetHubspot.data.hs_object_id || null }}"
    },
    "attributes": {
      "email": "{{ $node.Salesforce.data.Email }}",
      "phone": "{{ $node.Salesforce.data.Phone }}",
      "company": "{{ $node.Salesforce.data.Account.Name }}"
    }
  }
}
```

### Stripe Customer

```json
{
  "source": {
    "system": "stripe",
    "object": "Customer",
    "recordId": "{{ $node.Stripe.data.id }}",
    "externalUrl": "https://dashboard.stripe.com/customers/{{ $node.Stripe.data.id }}",
    "pulledAt": "{{ now.toISOString() }}"
  },
  "entity": {
    "type": "Company",
    "name": "{{ $node.Stripe.data.description || $node.Stripe.data.email }}",
    "attributes": {
      "stripe_plan": "{{ $node.Stripe.data.metadata.plan }}",
      "mrr": "{{ $node.Stripe.data.metadata.monthly_recurring }}"
    }
  },
  "event": {
    "kind": "metric_recorded",
    "validAt": "{{ new Date($node.Stripe.data.created * 1000).toISOString() }}",
    "amount": "{{ $node.Stripe.data.metadata.monthly_recurring }}",
    "narrative": "Stripe customer synced with current plan: {{ $node.Stripe.data.metadata.plan }}. MRR: {{ $node.Stripe.data.metadata.monthly_recurring }}"
  }
}
```

## Error Handling

HiveMind returns:

- **200 Created** — New record created
- **200 Updated** — Existing record updated (idempotencyKey matched)
- **204 Skipped** — `lastModifiedAt` stale, ignored
- **400 Bad Request** — Schema validation failed (check narrative, dates, required fields)
- **409 Conflict** — Concurrent writes, retry with exponential backoff
- **500 Server Error** — Retry with exponential backoff

n8n retry strategy:

```javascript
// Use n8n's built-in HTTP retry + exponential backoff
const response = await http({
  method: "POST",
  url: env.HIVEMIND_INGEST_URL,
  data: payload,
  retry: {
    maxRetries: 5,
    backoff: 2, // exponential: 1s, 2s, 4s, 8s, 16s
    maxWait: 30000
  }
});

// Log canonical ID on error for debugging
if (response.status >= 400) {
  console.error(`Ingest failed for ${payload.entity.canonicalId}`, response.data);
}
```

## Testing Payloads

Validate locally before deploying n8n workflow:

```bash
# Using ajv-cli
npx ajv validate -s hivemind_n8n_schema.json -d payload.json

# Or in n8n Code node:
const Ajv = require("ajv");
const ajv = new Ajv();
const schema = JSON.parse(fs.readFileSync("schema.json", "utf8"));
const valid = ajv.validate(schema, payload);
```

Example test payloads are in `hivemind_n8n_field_requirements.md`.

## Reference: All Event Kinds

| Kind | When | Example Narrative |
|------|------|-------------------|
| `created` | Entity first appeared | "Contact created via form submission" |
| `updated` | Generic mutation | "Email changed from old@example.com to new@example.com" |
| `deleted` | Hard delete | "Contact deleted per GDPR request" |
| `merged` | Duplicate resolution | "Merged into canonical contact ABC123 (duplicate)" |
| `status_changed` | Status field updated | "Lead qualified; CFO approved budget" |
| `property_changed` | Single field mutation | "Title changed to VP of Sales" |
| `score_calculated` | Scoring event | "Churn risk = 78; inactivity 45d + NPS degraded" |
| `metric_recorded` | Metric emission | "Monthly spend recorded: $2,500 MRR" |
| `interaction_logged` | Call, email, meeting | "Demo call with product fit discussion" |
| `engagement_event` | User action | "Opened email: Q3 roadmap announcement" |
| `custom` | Domain-specific | Use only if others don't fit |

