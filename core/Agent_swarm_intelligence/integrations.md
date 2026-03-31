# HIVEMIND Integrations & Platform Connectors

This document comprehensively documents all platform integrations, data sources, and external services that feed into HIVEMIND.

---

## Overview

HIVEMIND ingests knowledge from multiple platforms and sources:

```
┌──────────────────────────────────────────────────────────────┐
│                    HIVEMIND INGESTION                        │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Email        Slack        GitHub       Linear      Notion   │
│  (Gmail)      (Chat)       (Issues)     (Tickets)   (Docs)   │
│     │            │            │           │          │      │
│     └────────────┴────────────┴───────────┴──────────┘      │
│                         │                                    │
│              SyncEngine (MCP Protocol)                       │
│                         │                                    │
│          Ingestion Pipeline (Memory Engine)                 │
│          Predict-Calibrate → Processor → Qdrant             │
│                         │                                    │
│              PostgreSQL + Qdrant + Redis                     │
│                                                              │
│              CSI Feedback Loop (Self-Improvement)           │
│                                                              │
│    Frontend (Da-vinci)  API (REST)  CLI (Node)              │
└──────────────────────────────────────────────────────────────┘
```

---

## 1. Email (Gmail)

### OAuth Configuration

**Scopes**:
```
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
```

**Setup**:
```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_CALLBACK_URL=https://api.hivemind.ai/oauth/gmail/callback
```

### Sync Mechanism

**Method**: Gmail API v1 with incremental sync via `historyId`.

**Flow**:
1. User authorizes HIVEMIND via OAuth consent screen
2. HIVEMIND stores refresh_token in secure DB
3. SyncEngine polls Gmail API every 5 minutes
4. Fetches new messages since last sync
5. Extracts: subject, body, from, to, cc, date, attachments
6. Routes to MemoryProcessor

**Configuration**:
```javascript
{
  provider: "gmail",
  syncInterval: 300000,      // 5 minutes
  batchSize: 10,             // Process 10 messages per sync
  maxRetries: 3,
  retryBackoff: 1000         // ms
}
```

### Content Processing

**Extraction** (per message):
```javascript
{
  source: "gmail",
  content: "[subject] + [body]",
  sender: "[from email]",
  recipients: "[to, cc emails]",
  timestamp: "[date]",
  attachmentMetadata: [
    { filename, mimeType, size }
  ],
  conversationThread: "[thread_id]"
}
```

**Filters** (skip):
- Automated messages (noreply@, notifications@, etc.)
- Announcements (>100 recipients)
- Marketing emails (unsubscribe links)
- Read receipts, delivery reports

**Decision Detection** (Decision Intelligence):
- Strong signals: "decided", "approved", "go with", "use X", "go with Y"
- Weak signals: "I think we should", "let's use", "prefer"

### OAuth Callback

**Endpoint**: `GET /oauth/authorize?provider=gmail`

Redirects to Google consent screen. User authorizes. Callback:
```
GET /oauth/gmail/callback?code=...&state=...
  → Exchange code for refresh_token
  → Store encrypted in DB
  → Redirect to frontend: /hivemind/app/connectors?status=success
```

---

## 2. Slack

### OAuth Configuration

**Scopes**:
```
chat:history
channels:history
users:read
users:read.email
team:read
reactions:read
files:read
```

**Setup**:
```bash
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_CALLBACK_URL=https://api.hivemind.ai/oauth/slack/callback
```

### Sync Mechanism

**Method**: Slack API with event subscriptions + polling.

**Event Subscriptions**:
- `message.channels`: New messages in channels
- `message.groups`: DMs
- `reaction_added`: Emoji reactions
- `file_created`: File uploads

**Real-time Ingestion**:
1. Slack sends webhook to `POST /api/connectors/slack/events`
2. HIVEMIND validates signature via `X-Slack-Request-Timestamp` + `X-Slack-Signature`
3. Routes message to MemoryProcessor
4. Returns 200 OK immediately (async processing)

**Fallback Polling**:
```javascript
// Every 6 hours, poll channel history for gaps
GET https://slack.com/api/conversations.history?channel=C123&limit=100
```

**Configuration**:
```javascript
{
  provider: "slack",
  eventWebhookUrl: "/api/connectors/slack/events",
  pollInterval: 21600000,    // 6 hours
  batchSize: 20,
  skipBots: true,
  skipThreadReplies: false   // Include threaded messages
}
```

### Content Processing

**Extraction** (per message):
```javascript
{
  source: "slack",
  content: "[message text] + [blocks] + [file descriptions]",
  channel: "[channel name]",
  user: "[user id]",
  timestamp: "[ts]",
  thread_ts: "[thread timestamp if reply]",
  reactions: ["thumbsup", "heart"],
  files: [
    { id, name, mimetype, size, url_private }
  ],
  mentions: ["@user1", "@channel"]
}
```

**Filters** (skip):
- Bot messages (unless important: deployments, alerts)
- Thread replies with <10 characters
- Emoji-only messages
- Archive channel messages

**Decision Detection**:
- Strong signals: "shipped", "deployed", "merged", "decided", "approved"
- Weak signals: "going with", "let's use", "moving to", "bump to p0"
- Platform-specific: deployment notifications, status updates

### Webhook Validation

```javascript
const timestamp = headers['x-slack-request-timestamp'];
const signature = headers['x-slack-signature'];

if (Math.abs(Date.now() - timestamp * 1000) > 300000) {
  return 401;  // Request too old
}

const baseString = `v0:${timestamp}:${body}`;
const computed = 'v0=' + hmac('sha256', SLACK_SIGNING_SECRET, baseString);
if (!crypto.timingSafeEqual(computed, signature)) {
  return 401;  // Invalid signature
}
```

---

## 3. GitHub

### OAuth Configuration

**Scopes**:
```
repo               # Full control of private repositories
read:org           # Read organization data
read:user          # Read user profile
```

**Setup**:
```bash
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_CALLBACK_URL=https://api.hivemind.ai/oauth/github/callback
```

### Sync Mechanism

**Method**: GitHub GraphQL API + webhook events.

**Webhook Events**:
- `push`: Code commits
- `pull_request`: PR creation, merge
- `issues`: Issue creation, closure
- `pull_request_review`: Code review comments
- `release`: Release creation

**Real-time Ingestion**:
1. GitHub sends webhook to `POST /api/connectors/github/webhook`
2. Verify signature via `X-Hub-Signature-256`
3. Extract relevant data
4. Route to MemoryProcessor

**Fallback Polling** (GraphQL):
```graphql
{
  viewer {
    repositories(first: 10) {
      nodes {
        name
        pullRequests(first: 10, orderBy: {direction: DESC, field: CREATED_AT}) {
          nodes { ... }
        }
        issues(first: 10, orderBy: {direction: DESC, field: CREATED_AT}) {
          nodes { ... }
        }
      }
    }
  }
}
```

**Configuration**:
```javascript
{
  provider: "github",
  webhookUrl: "/api/connectors/github/webhook",
  pollInterval: 3600000,     // 1 hour
  includeRepositories: ["repo1", "repo2"],  // Optional filter
  skipForks: true,
  skipDrafts: true
}
```

### Content Processing

**PR/Issue Extraction**:
```javascript
{
  source: "github",
  content: "[title] + [body] + [review comments] + [commit messages]",
  type: "pull_request" | "issue" | "commit" | "review",
  repository: "[owner/repo]",
  number: 123,
  author: "[github handle]",
  created_at: "[timestamp]",
  merged_at: "[timestamp if merged]",
  status: "open" | "merged" | "closed",
  labels: ["bug", "feature"],
  related_prs: ["PR #456"],
  related_issues: ["Issue #789"]
}
```

**Decision Detection**:
- Strong signals: "merged", "closed", "lgtm", "approved"
- Action events: `pull_request.merged`, `issues.closed`, `pull_request_review.submitted`
- +0.35 confidence for GitHub actions

**Code Analysis**:
- Commit messages parsed for decisions ("fix X", "implement Y", "refactor Z")
- PR descriptions analyzed for architectural decisions
- Review comments for disagreements/consensus

### Webhook Validation

```javascript
const signature = headers['x-hub-signature-256'];
const computed = 'sha256=' + hmac('sha256', GITHUB_WEBHOOK_SECRET, body);
if (!crypto.timingSafeEqual(computed, signature)) {
  return 401;  // Invalid signature
}
```

---

## 4. Linear (Issue Tracking)

### API Configuration

**Setup**:
```bash
LINEAR_API_KEY=...
LINEAR_API_URL=https://api.linear.app/graphql
```

### Sync Mechanism

**Method**: Linear GraphQL API with polling.

**Query** (every 1 hour):
```graphql
{
  issues(first: 50, orderBy: {direction: DESC, field: CREATED_AT}) {
    nodes {
      id
      title
      description
      state { name }
      priority
      createdAt
      updatedAt
      assignee { name email }
      team { name }
      comments(first: 10) { nodes { body author { name } createdAt } }
    }
  }
}
```

**Configuration**:
```javascript
{
  provider: "linear",
  apiKey: LINEAR_API_KEY,
  pollInterval: 3600000,     // 1 hour
  batchSize: 50,
  includeTeams: [],          // Empty = all teams
  skipArchived: true
}
```

### Content Processing

**Extraction**:
```javascript
{
  source: "linear",
  content: "[title] + [description] + [comments]",
  issueType: "issue" | "task" | "bug",
  priority: 0 | 1 | 2 | 3 | 4,      // None, Low, Medium, High, Urgent
  status: "Backlog" | "Todo" | "In Progress" | "Done",
  team: "[team name]",
  assignee: "[email]",
  created_at: "[timestamp]",
  updated_at: "[timestamp]",
  closed_at: "[timestamp if closed]",
  labels: [string],
  estimated_hours: number,
  actual_hours: number,
  related_issues: ["LINEAR-123"]
}
```

**Decision Detection**:
- Strong signals: "decided on X", "approved", "going with", "will implement"
- Status changes (Todo → In Progress) imply decisions
- Priority changes (Low → High) indicate decision updates

---

## 5. Notion (Documentation)

### API Configuration

**Setup**:
```bash
NOTION_API_KEY=...
NOTION_DATABASE_ID=...
```

### Sync Mechanism

**Method**: Notion API v1 with polling.

**Query** (every 2 hours):
```
GET https://api.notion.com/v1/databases/{database_id}/query
```

**Configuration**:
```javascript
{
  provider: "notion",
  apiKey: NOTION_API_KEY,
  databaseIds: ["{id1}", "{id2}"],
  pollInterval: 7200000,     // 2 hours
  includeArchived: false,
  maxResults: 100
}
```

### Content Processing

**Extraction** (per Notion page):
```javascript
{
  source: "notion",
  content: "[title] + [rich text blocks] + [inline databases]",
  pageId: "[notion page id]",
  url: "[notion page url]",
  created_by: "[email]",
  last_edited_by: "[email]",
  created_time: "[timestamp]",
  last_edited_time: "[timestamp]",
  properties: {
    // Custom Notion database properties
    category: string,
    status: enum,
    owner: person
  }
}
```

**Block Types Extracted**:
- Headings, paragraphs, lists
- Code blocks (with language detection)
- Database relations (embedded tables)
- Files and images (metadata only)

---

## 6. MCP (Model Context Protocol)

### Purpose

MCP servers expose specialized tools and data sources to HIVEMIND's Trail Executor.

### Registered MCP Servers

**Available MCP Servers** (auto-discovered):
```javascript
GET /api/connectors/mcp/jobs
```

**Example Response**:
```json
{
  "servers": [
    {
      "name": "web-search",
      "capabilities": ["search"],
      "tools": ["web_search", "web_crawl"]
    },
    {
      "name": "github-api",
      "capabilities": ["query", "mutate"],
      "tools": ["get_repo", "get_issues", "create_issue"]
    }
  ]
}
```

### Job Control

**Submit Job**:
```javascript
POST /api/connectors/mcp/jobs {
  server: "web-search",
  tool: "web_search",
  params: { query: "HIVEMIND memory engine" }
}
```

**Response**:
```json
{
  "job_id": "uuid",
  "status": "pending" | "running" | "completed" | "failed",
  "result": {}
}
```

**Poll Status**:
```javascript
GET /api/connectors/mcp/jobs/:job_id
```

---

## 7. Web Crawl & Search

### Web Search

**Configuration**:
```javascript
{
  provider: "web-search",
  engine: "google" | "duckduckgo" | "perplexity",
  dailyLimit: 100,
  resultsPerQuery: 10
}
```

**Usage** (within Trail Executor):
```javascript
POST /api/swarm/execute {
  goal: "search_web",
  initial_context: {
    query: "latest advances in reasoning models"
  }
}
```

**Processing**:
1. Submit query to search engine
2. Extract top results (title, snippet, URL)
3. Ingest URLs for crawling
4. Route summaries to MemoryProcessor

### Web Crawl

**Configuration**:
```javascript
{
  provider: "web-crawl",
  dailyLimit: 50,
  crawlDepth: 2,             // Follow links 1-2 hops deep
  timeout: 30000,            // 30 seconds per page
  skipPatterns: [
    "/login", "/auth", "/admin", "/api",
    "\.pdf$", "\.zip$", "\.exe$"
  ]
}
```

**Processing**:
1. Fetch URL
2. Parse HTML (remove boilerplate, ads)
3. Extract main content
4. Code block detection via AST
5. Route to MemoryProcessor

---

## 8. API Key Management

### User API Keys

**Generate**:
```javascript
POST /api/keys/generate {
  name: "my-integration",
  scopes: ["memories:read", "memories:write", "swarm:execute"],
  expiresIn: "90d"
}
```

**Response**:
```json
{
  "key": "hm_sk_...",
  "secret": "hm_sec_...",
  "created_at": "2026-03-30T..."
}
```

**Usage**:
```bash
curl -H "X-API-Key: hm_sk_..." https://api.hivemind.ai/api/...
```

**Revoke**:
```javascript
DELETE /api/keys/{key_id}
```

### OAuth Tokens

**Stored Encrypted**:
```javascript
// In PostgreSQL
OAuthToken {
  id: uuid,
  user_id: uuid,
  provider: "gmail" | "slack" | "github" | "linear",
  access_token: string (encrypted),
  refresh_token: string (encrypted),
  expires_at: datetime,
  scopes: [string],
  created_at: datetime,
  last_used_at: datetime
}
```

**Encryption** (AES-256-GCM):
```javascript
const encrypted = crypto.createCipheriv(
  'aes-256-gcm',
  derivedKey,
  iv
).update(plaintext);
```

**Auto-Refresh**: Tokens refreshed 5 minutes before expiry.

---

## 9. Sync Engine (Core Orchestration)

### SyncManager

**Purpose**: Coordinate syncs across all connectors.

**Process**:
```javascript
class SyncManager {
  async startSync() {
    // 1. Load all enabled connectors
    const connectors = await this.db.getEnabledConnectors();

    // 2. Run syncs in parallel (with rate limiting)
    const syncs = connectors.map(c => this.syncConnector(c));
    await Promise.all(syncs);

    // 3. Trigger ingestion pipeline
    await this.ingest.processQueue();

    // 4. CSI feedback loop
    await this.csi.runResident('faraday');
  }

  async syncConnector(connector) {
    try {
      const data = await connector.fetch();  // OAuth validated
      for (const item of data) {
        await this.ingest.queue(item);
      }
    } catch (e) {
      await this.logError(connector, e);
      // Retry with exponential backoff
    }
  }
}
```

**Configuration**:
```javascript
{
  maxConcurrentSyncs: 3,
  retryBackoff: [1000, 5000, 30000],  // Exponential: 1s, 5s, 30s
  maxRetries: 3,
  triggerCsiAfterSync: true
}
```

### Error Handling

**Log Failed Sync**:
```javascript
SyncError {
  connector: "gmail",
  error: "OAuth token expired",
  attempt: 1,
  nextRetryAt: "2026-03-30T10:30:00Z",
  message_sent_to_user: true
}
```

**User Notification**:
- Email: "Gmail sync failed. Please re-authorize."
- UI: Alert in Connectors page

---

## 10. Data Residency & Compliance

### GDPR Mode

**Configuration**:
```bash
GDPR_MODE=true
DATA_RESIDENCY=EU
EU_REGION=eu-central-1
```

**Enforcement**:
- All data stored in EU datacenters (no US migration)
- Encryption at rest (AES-256)
- Encryption in transit (TLS 1.3)
- Right to deletion: 30-day data purge on user request
- Consent tracking for each connector

### Consent Management

```javascript
ConnectorConsent {
  user_id: uuid,
  provider: "gmail",
  scopes: [string],
  consent_given_at: datetime,
  consent_withdrawn_at: datetime | null,
  ip_address: string,
  user_agent: string,
  data_processed_count: int
}
```

**Withdrawal**:
```javascript
DELETE /api/connectors/{provider}/consent
```

Triggers:
1. OAuth token revocation
2. 30-day data retention countdown
3. User notification

---

## 11. Connector Status & Monitoring

### Health Checks

**Endpoint**:
```javascript
GET /api/connectors/status
```

**Response**:
```json
{
  "connectors": [
    {
      "provider": "gmail",
      "status": "healthy",
      "last_sync": "2026-03-30T10:15:00Z",
      "memory_count": 1240,
      "error": null
    },
    {
      "provider": "slack",
      "status": "error",
      "last_sync": "2026-03-30T09:45:00Z",
      "memory_count": 3420,
      "error": "OAuth token expired"
    }
  ]
}
```

### Metrics Dashboard

**Tracked**:
- Memories ingested per connector
- Sync latency (mean, p95, p99)
- Error rate (%)
- OAuth token refresh rate
- Decision detection precision per platform

---

## 12. Integration Roadmap

### Completed
- Gmail (OAuth, incremental sync, decision detection)
- Slack (webhooks, polling, decision detection)
- GitHub (webhooks, GraphQL API, code analysis)
- Linear (GraphQL polling)
- Notion (API v1 polling)
- Web search & crawl (API integration)
- MCP framework (generic tool registration)

### Planned (Q2 2026)
- Microsoft Teams (OAuth, Event Grid webhooks)
- Jira (OAuth, webhook events)
- Confluence (API polling)
- Asana (OAuth, webhooks)
- Calendars (Google Calendar, Outlook)
- Audio (Zoom transcripts, call recordings)
- Code repos (GitLab, Gitea)
- Custom HTTP webhooks (generic sink)

### Future Vision
- Real-time AI-generated summaries of connector data
- Cross-connector correlation (Gmail + Slack + GitHub)
- Privacy-preserving federated ingestion (edge processing)
- Connector plugin marketplace

---

*Integration Catalog. HIVEMIND © 2026.*
