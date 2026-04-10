# Enterprise Document Upload & Schema Extraction

**Date:** 2026-04-10
**Status:** Approved
**Endpoint:** `POST /api/enterprise/upload/detect` + `POST /api/enterprise/upload/ingest`

## Problem

The existing `/api/knowledge/upload` endpoint treats all documents identically — semantic text splitting at 800-char boundaries with generic `knowledge-base` + `document` tags. Enterprise documents (invoices, contracts, SOPs, spreadsheets, meeting notes) have inherent structure that gets destroyed by generic chunking. This leads to poor recall for structured queries like "find all invoices from Acme" or "what contracts expire this quarter".

Additionally, Excel/XLSX files are not supported at all.

## Solution

A new **schema-first pipeline** where document type detection and structured extraction drive the chunking strategy. The upload becomes a two-step process: detect type first (with user confirmation), then extract and ingest using type-specific schemas.

## Architecture

### Two-Step Upload Flow

```
Step 1: POST /api/enterprise/upload/detect
  Input:  multipart/form-data with file
  Output: { upload_id, detected_type, confidence, preview, sheets[] }
  Effect: Parses file, runs LLM type detection, stores in pending map (10min TTL)

Step 2: POST /api/enterprise/upload/ingest
  Input:  { upload_id, confirmed_type, sheet_configs[], tags, targetScope, containerTag, model? }
  Output: { job_id, status: 'processing', memories_created, schema_fields }
  Effect: Runs schema extraction → type-specific chunking → memory creation + Qdrant embed
```

### Temporary Storage

In-memory `Map<upload_id, { buffer, filename, mimeType, sheets[], parsedText, detectedType, confidence, createdAt }>` with 10-minute sweep interval. No Redis/DB needed — server restart means re-upload.

### LLM Integration

All extraction calls go through LiteLLM proxy at `LITELLM_BASE_URL/chat/completions`.
- Default model: `gemini-2.5-flash-lite`
- Override via `ENTERPRISE_EXTRACTION_MODEL` env var or per-request `model` field
- Uses `response_format: { type: "json_object" }` for structured output
- Reuses existing `LITELLM_API_KEY` from env

## Document Type Schemas

Six types at launch. Each has required core fields + LLM can discover additional fields.

### Invoice / Purchase Order
- **Required:** `vendor`, `total_amount`, `currency`, `date`
- **Optional:** `invoice_number`, `po_number`, `line_items[]` (description, quantity, unit_price, amount), `payment_terms`, `due_date`, `tax_amount`, `billing_address`

### Company Knowledge Base / SOP
- **Required:** `title`, `category`
- **Optional:** `version`, `effective_date`, `department`, `sections[]` (title, content), `review_date`, `owner`, `audience`, `keywords[]`

### Spreadsheet / Data Export
- **Required:** `sheet_name`, `headers[]`, `row_count`
- **Optional:** `data_type` (financial, inventory, HR, analytics), `date_range`, `summary_statistics`, `key_columns[]`, `notable_patterns`

### Contract / Legal
- **Required:** `parties[]`, `effective_date`, `document_title`
- **Optional:** `expiry_date`, `clauses[]` (title, content, type), `governing_law`, `renewal_terms`, `termination_conditions`, `signatures[]`, `contract_value`

### Meeting Notes / Reports
- **Required:** `title`, `date`
- **Optional:** `attendees[]`, `agenda_items[]`, `decisions[]`, `action_items[]` (owner, deadline, description), `summary`, `follow_up_date`

### General / Other (fallback)
- **Required:** `title`
- **Optional:** `summary`, `key_topics[]`, `entities[]` (name, type), `dates[]`, `references[]`

Schemas stored in dedicated `core/src/knowledge/enterprise/schemas/` folder for easy extension.

## Schema-First Chunking Strategy

Document type determines how content is split into memories.

### Invoice / Purchase Order
- **Parent schema memory:** Full extracted fields (vendor, total, dates, all line items)
- **Child chunks:** One memory per line item + one for header/terms section
- **Tags:** `enterprise`, `document_type:invoice`, `vendor:{name}`, `currency:{code}`

### Company Knowledge Base / SOP
- **Parent schema memory:** Title, category, version, section outline
- **Child chunks:** One memory per section/subsection (respects document hierarchy)
- **Tags:** `enterprise`, `document_type:sop`, `department:{dept}`, `category:{cat}`

### Spreadsheet / Data Export
- **Parent schema memory per sheet:** Headers, row count, summary stats
- **Child chunks:** Rows grouped in logical blocks (~20-50 rows), column headers preserved in each chunk
- **Tags:** `enterprise`, `document_type:spreadsheet`, `sheet:{name}`, `data_type:{type}`

### Contract / Legal
- **Parent schema memory:** Parties, dates, value, clause index
- **Child chunks:** One memory per clause
- **Tags:** `enterprise`, `document_type:contract`, `party:{name}`, `clause_type:{type}`

### Meeting Notes / Reports
- **Parent schema memory:** Attendees, decisions, action items
- **Child chunks:** One per agenda item or logical section + dedicated action items chunk
- **Tags:** `enterprise`, `document_type:meeting`, `attendee:{name}`, `action_owner:{name}`

### General / Other
- Falls back to semantic chunking (800 char target, same as existing)
- Parent schema memory with whatever LLM extracted
- **Tags:** `enterprise`, `document_type:general`, `topic:{topic}`

## Memory Structure

### Tag Strategy

Every enterprise memory gets:
1. `enterprise` — global filter for all enterprise docs
2. `document_type:{type}` — type-level filtering
3. Field-derived tags — `vendor:acme-corp`, `party:acme-corp`, `department:legal`, etc.
4. User-provided tags — passed through from upload
5. `upload:{upload_id}` — links all memories from same upload

Parent schema memories additionally get `schema-record` tag.

### Parent Schema Memory

```javascript
{
  content: "[LLM-generated natural language summary of extracted fields]",
  title: "{Type}: {primary_identifier}",
  memory_type: 'fact',
  tags: ['enterprise', 'document_type:{type}', '{field}:{value}', 'schema-record', 'upload:{id}', ...userTags],
  metadata: {
    extracted_schema: { /* all extracted fields */ },
    document_type: "{type}",
    detection_confidence: 0.92,
    extraction_model: "gemini-2.5-flash-lite",
    filename: "{original_filename}",
    total_chunks: N,
    source_upload_id: "{upload_id}"
  },
  source_metadata: {
    source_type: 'enterprise-upload',
    source_platform: 'knowledge-base',
    source_id: 'enterprise:{upload_id}',
    filename: "{original_filename}"
  }
}
```

### Child Chunk Memory

```javascript
{
  content: "[chunk content — line item / clause / section / row group]",
  title: "{Type}: {parent_identifier} — {chunk_label}",
  memory_type: 'fact',
  tags: ['enterprise', 'document_type:{type}', '{field}:{value}', 'upload:{id}', ...userTags],
  metadata: {
    document_type: "{type}",
    parent_schema_id: "{parent_memory_id}",
    chunk_type: "line_item|clause|section|row_group|action_items",
    chunk_index: N,
    total_chunks: N,
    extracted_fields: { /* chunk-level extracted fields */ }
  },
  source_metadata: {
    source_type: 'enterprise-upload',
    source_platform: 'knowledge-base',
    source_id: 'enterprise:{upload_id}:chunk:{N}'
  }
}
```

### Relationship Linking
- Parent-to-child: `CONTAINS` relationship edge
- Cross-document: existing relationship classifier detects `RELATED` edges when vendor/party names match

## Recall Benefits

| Query | How it works |
|-------|-------------|
| "How much did we pay Acme?" | Tag boost on `vendor:acme-corp` (+0.15) + schema memory content has total → high vector similarity |
| "Show all invoices over 10k" | Filter `schema-record` + `document_type:invoice` via GIN index, then `metadata.extracted_schema.total_amount > 10000` |
| "What cloud services are we paying for?" | Chunk-level vector similarity on "Cloud Infrastructure Services" + `document_type:invoice` filter available |
| "Contracts expiring this quarter" | Filter `schema-record` + `document_type:contract`, check `metadata.extracted_schema.expiry_date` range |
| "Action items from last meeting" | Tag filter `document_type:meeting` + vector similarity on "action items" |

## Excel/XLSX Handling

- Each sheet becomes a separate document with its own type detection
- User can select which sheets to ingest and override type per sheet
- Sheet names shown in detection modal with checkboxes
- Per-sheet `sheet_configs[]`: `{ sheet_name, confirmed_type, include: boolean }`

## File Structure

### New Files
```
core/src/knowledge/enterprise/
├── schemas/                    # Dedicated schema folder
│   ├── index.js               # Schema registry + lookup
│   ├── invoice.js
│   ├── contract.js
│   ├── sop.js
│   ├── spreadsheet.js
│   ├── meeting.js
│   └── general.js
├── detector.js                # Document type auto-detection via LLM
├── extractor.js               # Schema extraction via LLM
├── enterprise-chunker.js      # Schema-driven chunking (per-type strategies)
├── excel-parser.js            # XLSX/XLS parsing
└── litellm-client.js          # LiteLLM chat completions client
```

### Modified Files
```
core/src/server.js                                              # Two new endpoints
frontend/Da-vinci/src/components/hivemind/app/pages/KnowledgeBase.jsx  # Detection modal, type badges, filters
frontend/Da-vinci/src/components/hivemind/app/shared/api-client.js     # New API methods
```

## Frontend Changes

### Detection Modal
Appears after file selection. Shows:
- Detected type with confidence + dropdown to override
- Sheet picker for Excel (checkboxes + per-sheet type dropdown)
- Scope selector (Personal / Team Workspace)
- Tags input
- Model selector (shows current extraction model)
- "Extract & Ingest" button → progress bar (Detecting → Extracting → Chunking → Indexing → Done)

### KnowledgeBase List View
- Document type badge with color-coded icon per type
- Filter dropdown: All Types / Invoices / Contracts / SOPs / Spreadsheets / Meetings / General
- Schema preview card: clicking a document shows extracted fields in structured view before chunk list
- Regular upload still works — enterprise extraction triggered via "Smart Extract" toggle

## Edge Cases

- **Low confidence detection (<50%):** Type defaults to "General", user sees warning "Could not determine document type — please select manually"
- **Empty Excel sheets:** Skipped in sheet list, not shown to user
- **Mixed-language documents:** Extraction prompt instructs LLM to extract fields regardless of language, content stored as-is
- **Extraction failure (LLM error/timeout):** Falls back to existing semantic chunking with `document_type:general` tag + user notified "Smart extraction failed, document ingested with standard processing"
- **Duplicate upload:** Idempotency via `upload_id` — re-submitting same `upload_id` to ingest returns cached result

## Constraints

- Max file size: 100MB (same as existing)
- Pending upload TTL: 10 minutes
- LLM model: `gemini-2.5-flash-lite` default, configurable
- No new database tables — uses existing Memory + SourceMetadata + tags + metadata JSON
- Existing `/api/knowledge/upload` untouched — enterprise is additive
