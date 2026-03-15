# API Key Management System

**HIVE-MIND Cross-Platform Context Sync**  
**Version:** 1.0.0  
**Compliance:** GDPR, NIS2, DORA  
**Last Updated:** March 12, 2026

---

## Overview

The HIVE-MIND API Key Management System provides secure server-to-server authentication with support for key expiry, revocation, and usage tracking. This system enables AI platforms (ChatGPT, Claude, etc.) to authenticate with HIVE-MIND APIs without requiring user interaction.

### Key Features

- ✅ **Secure Key Generation**: Cryptographically secure API keys with `hmk_` prefix
- ✅ **Key Expiry**: Optional expiration dates for temporary access
- ✅ **Key Revocation**: Immediate revocation with audit trail
- ✅ **Last-Used Tracking**: Automatic tracking of key usage
- ✅ **Usage Counting**: Total authentication count per key
- ✅ **Scope-Based Authorization**: Fine-grained permission control
- ✅ **Rate Limiting**: Per-key rate limiting (requests/minute)
- ✅ **Multi-Tenant Isolation**: Users can only access their own keys
- ✅ **Audit Logging**: All operations logged for NIS2/DORA compliance

---

## Database Schema

### `api_keys` Table

```sql
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id UUID REFERENCES organizations(id) ON DELETE SET NULL,

    -- Key identification
    name VARCHAR(255) NOT NULL,
    key_hash VARCHAR(255) UNIQUE NOT NULL,      -- SHA-256 hash
    key_prefix VARCHAR(20) NOT NULL,            -- First 14 chars (e.g., "hmk_abc123")

    -- Key lifecycle
    expires_at TIMESTAMPTZ,                      -- NULL = never expires
    revoked_at TIMESTAMPTZ,                      -- NULL = still active
    revoked_reason VARCHAR(255),

    -- Usage tracking
    last_used_at TIMESTAMPTZ,
    usage_count INTEGER DEFAULT 0,

    -- Permissions & scopes
    scopes TEXT[] DEFAULT ARRAY['read', 'write'],
    rate_limit_per_minute INTEGER DEFAULT 60,

    -- Metadata
    description TEXT,
    created_by_ip INET,
    user_agent TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
```

### Indexes

```sql
CREATE INDEX idx_api_keys_user ON api_keys(user_id);
CREATE INDEX idx_api_keys_org ON api_keys(org_id);
CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_active ON api_keys(user_id, revoked_at, expires_at) 
    WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP);
```

---

## API Endpoints

### Base URL

```
Production: https://api.hivemind.io/v1
Staging:    https://api-staging.hivemind.io/v1
```

### Authentication

All API key management endpoints require **JWT authentication** (ZITADEL OIDC). API keys themselves cannot be used to manage other API keys (security best practice).

```bash
# Include JWT token in Authorization header
Authorization: Bearer <jwt_token>
```

---

### POST /api/keys

Create a new API key.

**Request:**

```bash
curl -X POST https://api.hivemind.io/v1/keys \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Production ChatGPT Integration",
    "description": "API key for ChatGPT Custom GPT Actions",
    "expiresAt": "2026-12-31T23:59:59Z",
    "scopes": ["read", "write", "memories:read"],
    "rateLimitPerMinute": 100
  }'
```

**Response (201 Created):**

```json
{
  "success": true,
  "data": {
    "id": "uuid-here",
    "name": "Production ChatGPT Integration",
    "keyPrefix": "hmk_abc123def456",
    "key": "hmk_abc123def456ghi789...",  // ⚠️ Shown ONLY once!
    "expiresAt": "2026-12-31T23:59:59.000Z",
    "scopes": ["read", "write", "memories:read"],
    "rateLimitPerMinute": 100,
    "description": "API key for ChatGPT Custom GPT Actions",
    "createdAt": "2026-03-12T10:00:00.000Z",
    "updatedAt": "2026-03-12T10:00:00.000Z"
  },
  "requestId": "uuid-request-id"
}
```

**⚠️ Important:** The plain text API key is shown **only once** at creation time. Store it securely immediately. It cannot be retrieved later.

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | Yes | - | Human-readable name for the key |
| `description` | string | No | null | Optional description |
| `expiresAt` | string (ISO 8601) | No | null | Expiration date/time |
| `scopes` | string[] | No | `["read", "write"]` | Permission scopes |
| `rateLimitPerMinute` | number | No | 60 | Max requests per minute |

**Available Scopes:**

| Scope | Description |
|-------|-------------|
| `read` | Read access to memories and data |
| `write` | Create and update memories |
| `admin` | Full administrative access (grants all scopes) |
| `memories:read` | Read memories only |
| `memories:write` | Create/update memories only |
| `memories:delete` | Delete memories |

**Error Responses:**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `VALIDATION_ERROR` | Invalid request body |
| 401 | `UNAUTHORIZED` | JWT authentication required |
| 403 | `INSUFFICIENT_SCOPE` | Requires write or admin scope |
| 500 | `INTERNAL_ERROR` | Server error |

---

### GET /api/keys

List all API keys for the authenticated user.

**Request:**

```bash
curl -X GET "https://api.hivemind.io/v1/keys?includeRevoked=false&limit=50&offset=0" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "keys": [
      {
        "id": "uuid-1",
        "name": "Production ChatGPT Integration",
        "keyPrefix": "hmk_abc123",
        "expiresAt": "2026-12-31T23:59:59.000Z",
        "revokedAt": null,
        "revokedReason": null,
        "lastUsedAt": "2026-03-12T09:30:00.000Z",
        "usageCount": 1523,
        "scopes": ["read", "write", "memories:read"],
        "rateLimitPerMinute": 100,
        "description": "API key for ChatGPT Custom GPT Actions",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-03-12T09:30:00.000Z",
        "organization": {
          "id": "uuid-org",
          "name": "My Organization",
          "slug": "my-org"
        }
      }
    ],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "total": 5
    },
    "stats": {
      "total": 10,
      "active": 7,
      "revoked": 2,
      "expired": 1,
      "expiringSoon": 2
    }
  },
  "requestId": "uuid-request-id"
}
```

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `includeRevoked` | boolean | false | Include revoked keys |
| `includeExpired` | boolean | false | Include expired keys |
| `limit` | number | 50 | Maximum results (max: 100) |
| `offset` | number | 0 | Pagination offset |

---

### GET /api/keys/:id

Get details of a specific API key.

**Request:**

```bash
curl -X GET https://api.hivemind.io/v1/keys/uuid-key-id \
  -H "Authorization: Bearer $JWT_TOKEN"
```

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "id": "uuid-key-id",
    "name": "Production ChatGPT Integration",
    "keyPrefix": "hmk_abc123",
    "expiresAt": "2026-12-31T23:59:59.000Z",
    "revokedAt": null,
    "revokedReason": null,
    "lastUsedAt": "2026-03-12T09:30:00.000Z",
    "usageCount": 1523,
    "scopes": ["read", "write", "memories:read"],
    "rateLimitPerMinute": 100,
    "description": "API key for ChatGPT Custom GPT Actions",
    "createdByIp": "203.0.113.42",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-03-12T09:30:00.000Z"
  },
  "requestId": "uuid-request-id"
}
```

**Error Responses:**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `API_KEY_NOT_FOUND` | Key not found or belongs to another user |
| 401 | `UNAUTHORIZED` | JWT authentication required |

---

### PUT /api/keys/:id

Update API key metadata.

**Request:**

```bash
curl -X PUT https://api.hivemind.io/v1/keys/uuid-key-id \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Updated Key Name",
    "description": "Updated description",
    "scopes": ["read"],
    "rateLimitPerMinute": 30
  }'
```

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "id": "uuid-key-id",
    "name": "Updated Key Name",
    "keyPrefix": "hmk_abc123",
    "expiresAt": "2026-12-31T23:59:59.000Z",
    "scopes": ["read"],
    "rateLimitPerMinute": 30,
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-03-12T10:00:00.000Z"
  },
  "requestId": "uuid-request-id"
}
```

**Updatable Fields:**

- `name` - Human-readable name
- `description` - Key description
- `expiresAt` - Expiration date (ISO 8601)
- `scopes` - Permission scopes
- `rateLimitPerMinute` - Rate limit

**⚠️ Note:** Cannot update revoked keys.

---

### DELETE /api/keys/:id

Revoke an API key.

**Request:**

```bash
curl -X DELETE "https://api.hivemind.io/v1/keys/uuid-key-id?reason=Security+concern" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "id": "uuid-key-id",
    "name": "Production ChatGPT Integration",
    "keyPrefix": "hmk_abc123",
    "revokedAt": "2026-03-12T10:00:00.000Z",
    "revokedReason": "Security concern",
    "expiresAt": "2026-12-31T23:59:59.000Z",
    "scopes": ["read", "write"],
    "createdAt": "2026-01-01T00:00:00.000Z"
  },
  "requestId": "uuid-request-id"
}
```

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `reason` | string | Optional reason for revocation |

---

### POST /api/keys/:id/revoke

Alternative endpoint to revoke an API key (POST instead of DELETE).

**Request:**

```bash
curl -X POST https://api.hivemind.io/v1/keys/uuid-key-id/revoke \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Key compromised"
  }'
```

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "id": "uuid-key-id",
    "name": "Production ChatGPT Integration",
    "keyPrefix": "hmk_abc123",
    "revokedAt": "2026-03-12T10:00:00.000Z",
    "revokedReason": "Key compromised"
  },
  "requestId": "uuid-request-id"
}
```

---

### GET /api/keys/stats

Get API key usage statistics.

**Request:**

```bash
curl -X GET https://api.hivemind.io/v1/keys/stats \
  -H "Authorization: Bearer $JWT_TOKEN"
```

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "total": 10,
    "active": 7,
    "revoked": 2,
    "expired": 1,
    "expiringSoon": 2
  },
  "requestId": "uuid-request-id"
}
```

**Statistics:**

| Field | Description |
|-------|-------------|
| `total` | Total number of API keys |
| `active` | Keys that are currently valid |
| `revoked` | Keys that have been revoked |
| `expired` | Keys that have expired |
| `expiringSoon` | Keys expiring in the next 7 days |

---

## Using API Keys for Authentication

Once created, API keys can be used to authenticate with HIVE-MIND APIs.

### Method 1: X-API-Key Header (Recommended)

```bash
curl -X GET https://api.hivemind.io/v1/memories \
  -H "X-API-Key: hmk_abc123def456ghi789..."
```

### Method 2: Query Parameter (for webhooks)

```bash
curl -X GET "https://api.hivemind.io/v1/memories?api_key=hmk_abc123def456ghi789..."
```

### Response

Authenticated requests include user context:

```json
{
  "success": true,
  "data": {
    "memories": [...]
  },
  "authMethod": "api_key",
  "userId": "uuid-user-id"
}
```

### Rate Limiting

API keys are rate-limited based on their `rateLimitPerMinute` setting.

**Response (429 Too Many Requests):**

```json
{
  "success": false,
  "error": "RATE_LIMIT_EXCEEDED",
  "message": "Rate limit of 60 requests per minute exceeded",
  "retryAfter": 60,
  "requestId": "uuid-request-id"
}
```

---

## Security Best Practices

### 1. Store Keys Securely

- Store API keys in environment variables or secret management systems
- Never commit keys to version control
- Use different keys for development, staging, and production

```bash
# Good practice
export HIVEMIND_API_KEY="hmk_abc123..."
```

### 2. Set Expiration Dates

Always set expiration dates for temporary integrations:

```bash
curl -X POST https://api.hivemind.io/v1/keys \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -d '{
    "name": "Temporary Migration Key",
    "expiresAt": "2026-04-12T00:00:00Z"
  }'
```

### 3. Use Minimal Scopes

Grant only the permissions needed:

```json
{
  "scopes": ["memories:read"]  // Read-only access
}
```

### 4. Monitor Usage

Regularly check `lastUsedAt` and `usageCount`:

```bash
curl https://api.hivemind.io/v1/keys \
  -H "Authorization: Bearer $JWT_TOKEN" | jq '.data.keys[] | {name, lastUsedAt, usageCount}'
```

### 5. Revoke Compromised Keys Immediately

```bash
curl -X DELETE https://api.hivemind.io/v1/keys/uuid-key-id \
  -H "Authorization: Bearer $JWT_TOKEN"
```

### 6. Rotate Keys Periodically

Create new keys and revoke old ones on a schedule (e.g., every 90 days).

---

## Compliance Features

### GDPR

- **Data Minimization**: Only necessary key metadata stored
- **Right to Erasure**: Keys deleted when user account is deleted (CASCADE)
- **Data Portability**: Keys included in data export requests
- **Audit Trail**: All key operations logged

### NIS2 / DORA

- **Access Control**: Multi-tenant isolation with RLS policies
- **Audit Logging**: 7-year retention for all key operations
- **Incident Response**: Immediate revocation capability
- **Rate Limiting**: Per-key rate limiting to prevent abuse

### Security

- **Hash Storage**: Keys stored as SHA-256 hashes (never plain text)
- **Secure Generation**: Cryptographically secure random generation
- **Multi-Tenant Isolation**: Row-level security policies
- **Audit Trail**: All mutations logged to `audit_logs` table

---

## Implementation Details

### File Structure

```
core/
├── src/
│   ├── services/
│   │   └── api-key.service.js      # Core service logic
│   ├── auth/
│   │   ├── api-keys.js             # API key auth middleware
│   │   └── middleware.js           # Unified auth middleware
│   └── api/
│       └── routes/
│           └── keys.js             # API endpoints
├── prisma/
│   ├── schema.prisma               # Prisma schema with ApiKey model
│   └── migrations/
│       └── 20260312000000_create_api_keys_table/
│           └── migration.sql       # Database migration
└── tests/
    ├── services/
    │   └── api-key.service.test.js
    ├── api/
    │   └── api-keys.routes.test.js
    └── auth/
        └── api-keys.middleware.test.js
```

### Key Generation Algorithm

```javascript
import { randomBytes } from 'crypto';

function generateApiKey() {
  const randomBytesData = randomBytes(32);
  const keyBody = randomBytesData.toString('base64url').slice(0, 32);
  return `hmk_${keyBody}`;
}
```

### Key Hashing

```javascript
import { createHash } from 'crypto';

function hashApiKey(apiKey) {
  return createHash('sha256').update(apiKey).digest('hex');
}
```

### Validation Flow

1. Extract API key from `X-API-Key` header or query parameter
2. Hash the provided key
3. Look up in database by `key_hash`
4. Check `revoked_at` is NULL
5. Check `expires_at` is NULL or in future
6. Update `last_used_at` and increment `usage_count`
7. Return user context

---

## Troubleshooting

### "Invalid or expired API key" (401)

**Causes:**
- Key has expired (`expires_at` in past)
- Key has been revoked (`revoked_at` is set)
- Key hash doesn't match database

**Solution:**
1. Check key status in API
2. Create new key if expired/revoked
3. Ensure correct key is being used

### "Rate limit exceeded" (429)

**Causes:**
- Too many requests in 1-minute window

**Solution:**
1. Increase `rateLimitPerMinute` for the key
2. Implement exponential backoff in client
3. Wait 60 seconds before retrying

### "Insufficient scope" (403)

**Causes:**
- API key doesn't have required scope

**Solution:**
1. Check key's scopes
2. Update key with required scopes
3. Use a different key with appropriate permissions

---

## Migration Guide

### Running the Migration

```bash
cd core
npx prisma migrate deploy
```

### Verifying the Migration

```sql
-- Check table exists
\dt api_keys

-- Check indexes
\di api_keys*

-- Test RLS policy
SET app.current_user_id = 'your-user-id';
SELECT * FROM api_keys;
```

---

## Testing

### Run Unit Tests

```bash
cd core
npm test -- tests/services/api-key.service.test.js
npm test -- tests/auth/api-keys.middleware.test.js
```

### Run Integration Tests

```bash
cd core
npm test -- tests/api/api-keys.routes.test.js
```

### Manual Testing

```bash
# 1. Create a key
curl -X POST http://localhost:3000/api/keys \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -d '{"name": "Test Key"}'

# 2. Use the key
curl -X GET http://localhost:3000/api/memories \
  -H "X-API-Key: hmk_..."

# 3. Revoke the key
curl -X DELETE http://localhost:3000/api/keys/$KEY_ID \
  -H "Authorization: Bearer $JWT_TOKEN"
```

---

## Support

For issues or questions:
- **Documentation**: See `CROSS_PLATFORM_SYNC_SPEC.md`
- **Issues**: GitHub Issues
- **Security**: security@hivemind.local

---

**© 2026 HIVE-MIND. All rights reserved.**  
**GDPR | NIS2 | DORA Compliant**  
**EU Data Sovereign**
