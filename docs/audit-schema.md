# Audit Log Schema Documentation

## Overview

This document defines the audit log schema for HIVE-MIND, designed to meet NIS2, DORA, and GDPR compliance requirements.

## Database Schema

```sql
-- Audit Logs Table (Immutable, Append-Only)
-- Retention: 7 years minimum (NIS2/DORA requirement)

CREATE TABLE audit_logs (
    -- Primary Key
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Actor Identification
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
    
    -- Event Classification
    event_type VARCHAR(100) NOT NULL,
    event_category VARCHAR(50) NOT NULL,
    
    -- Resource Context
    resource_type VARCHAR(50),
    resource_id UUID,
    
    -- Action Details
    action VARCHAR(50) NOT NULL,
    old_value JSONB,  -- State before action (for updates/deletes)
    new_value JSONB,  -- State after action (for creates/updates)
    
    -- Request Context
    ip_address INET,
    user_agent TEXT,
    platform_type VARCHAR(50),
    session_id UUID,
    
    -- Compliance Fields
    processing_basis VARCHAR(100),  -- GDPR Article 6 basis
    legal_basis_note TEXT,
    
    -- Timestamp (immutable)
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for Query Performance
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_org ON audit_logs(organization_id);
CREATE INDEX idx_audit_logs_event ON audit_logs(event_type);
CREATE INDEX idx_audit_logs_category ON audit_logs(event_category);
CREATE INDEX idx_audit_logs_time ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_resource ON audit_logs(resource_type, resource_id);

-- Composite Index for Common Queries
CREATE INDEX idx_audit_logs_user_time ON audit_logs(user_id, created_at DESC);
CREATE INDEX idx_audit_logs_org_time ON audit_logs(organization_id, created_at DESC);
```

## Field Definitions

### Primary Key

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Unique identifier for each log entry. Generated using `gen_random_uuid()`. |

### Actor Identification

| Field | Type | Description | Required |
|-------|------|-------------|----------|
| `user_id` | UUID | ID of the user who performed the action. Set to NULL if system action. | No |
| `organization_id` | UUID | ID of the organization context. Used for multi-tenant queries. | No |

### Event Classification

| Field | Type | Description | Values |
|-------|------|-------------|--------|
| `event_type` | VARCHAR(100) | Specific type of event | See Event Types below |
| `event_category` | VARCHAR(50) | High-level category for filtering | See Categories below |

#### Event Categories

| Category | Description | Example Event Types |
|----------|-------------|---------------------|
| `authentication` | Login, logout, token events | `login_success`, `login_failure`, `logout` |
| `authorization` | Permission and role changes | `permission_granted`, `role_assigned` |
| `data_access` | Data read operations | `data_read`, `data_search`, `data_export` |
| `data_modification` | Data write operations | `data_created`, `data_updated`, `data_deleted` |
| `data_export` | GDPR export operations | `data_export_requested`, `data_export_completed` |
| `data_erasure` | GDPR erasure operations | `erasure_requested`, `erasure_completed` |
| `security` | Security-related events | `security_violation`, `brute_force_detected` |
| `system` | System operations | `system_startup`, `config_changed`, `key_rotation` |
| `compliance` | Compliance operations | `consent_granted`, `audit_export` |
| `administration` | Admin operations | `user_created`, `organization_updated` |

#### Event Types (Comprehensive List)

```javascript
// Authentication
LOGIN_SUCCESS, LOGIN_FAILURE, LOGOUT, TOKEN_REFRESH, TOKEN_REVOKED,
MFA_ENABLED, MFA_DISABLED, PASSWORD_CHANGED, PASSWORD_RESET,

// Authorization
PERMISSION_GRANTED, PERMISSION_REVOKED, ROLE_ASSIGNED, ROLE_REMOVED,

// Data Access
DATA_READ, DATA_SEARCH, DATA_EXPORT_REQUESTED, DATA_EXPORT_COMPLETED,

// Data Modification
DATA_CREATED, DATA_UPDATED, DATA_DELETED, DATA_RESTORED,

// Data Erasure
ERASURE_REQUESTED, ERASURE_CANCELLED, ERASURE_COMPLETED,

// Security
SECURITY_VIOLATION, RATE_LIMIT_EXCEEDED, INVALID_TOKEN,
SUSPICIOUS_ACTIVITY, BRUTE_FORCE_DETECTED, INJECTION_ATTEMPT,
XSS_ATTEMPT, CSRF_VIOLATION,

// System
SYSTEM_STARTUP, SYSTEM_SHUTDOWN, CONFIG_CHANGED, KEY_ROTATION,
BACKUP_CREATED, BACKUP_RESTORED,

// Compliance
CONSENT_GRANTED, CONSENT_WITHDRAWN, ARTICLE_30_REPORT, AUDIT_EXPORT,
```

### Resource Context

| Field | Type | Description | Values |
|-------|------|-------------|--------|
| `resource_type` | VARCHAR(50) | Type of resource affected | `user`, `organization`, `memory`, `session`, `integration`, `consent`, `audit_log`, `system` |
| `resource_id` | UUID | ID of the specific resource | Resource-specific UUID |

### Action Details

| Field | Type | Description | Values |
|-------|------|-------------|--------|
| `action` | VARCHAR(50) | Action performed | `create`, `read`, `update`, `delete`, `export`, `erase`, `login`, `logout`, `grant`, `revoke` |
| `old_value` | JSONB | Previous state of resource (for updates/deletes) | JSON object |
| `new_value` | JSONB | New state of resource (for creates/updates) | JSON object |

**Note:** Sensitive fields in `old_value` and `new_value` are automatically redacted:
- `password`, `token`, `accessToken`, `refreshToken`
- `apiKey`, `secret`, `privateKey`, `encryptionKey`
- `creditCard`, `ssn`

### Request Context

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `ip_address` | INET | Client IP address (IPv4/IPv6) | `192.168.1.1` |
| `user_agent` | TEXT | Client user agent string (truncated to 500 chars) | `Mozilla/5.0...` |
| `platform_type` | VARCHAR(50) | Platform making the request | `chatgpt`, `claude`, `web`, `cli`, `api` |
| `session_id` | UUID | Session identifier | Session UUID |

### Compliance Fields

| Field | Type | Description | Values |
|-------|------|-------------|--------|
| `processing_basis` | VARCHAR(100) | GDPR Article 6 legal basis | `consent`, `contract`, `legal_obligation`, `legitimate_interest` |
| `legal_basis_note` | TEXT | Additional legal notes | Free text |

### Timestamp

| Field | Type | Description | Notes |
|-------|------|-------------|-------|
| `created_at` | TIMESTAMPTZ | When the event occurred | Immutable, defaults to `CURRENT_TIMESTAMP` |

## Example Log Entries

### User Login

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "user_id": "user-123",
  "organization_id": "org-456",
  "event_type": "login_success",
  "event_category": "authentication",
  "resource_type": "user",
  "resource_id": "user-123",
  "action": "login",
  "old_value": null,
  "new_value": null,
  "ip_address": "192.168.1.100",
  "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)...",
  "platform_type": "web",
  "session_id": "session-789",
  "processing_basis": "contract",
  "legal_basis_note": null,
  "created_at": "2026-03-09T10:30:00Z"
}
```

### Memory Created

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440001",
  "user_id": "user-123",
  "organization_id": "org-456",
  "event_type": "data_created",
  "event_category": "data_modification",
  "resource_type": "memory",
  "resource_id": "memory-abc",
  "action": "create",
  "old_value": null,
  "new_value": {
    "id": "memory-abc",
    "content": "[REDACTED]",
    "memoryType": "fact",
    "visibility": "private"
  },
  "ip_address": "192.168.1.100",
  "user_agent": "HIVE-MIND-Web/1.0",
  "platform_type": "web",
  "session_id": "session-789",
  "processing_basis": "contract",
  "legal_basis_note": null,
  "created_at": "2026-03-09T10:35:00Z"
}
```

### GDPR Export Requested

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440002",
  "user_id": "user-123",
  "organization_id": null,
  "event_type": "data_export_requested",
  "event_category": "data_export",
  "resource_type": "user",
  "resource_id": "user-123",
  "action": "export",
  "old_value": null,
  "new_value": {
    "exportRequestId": "export-xyz",
    "format": "json"
  },
  "ip_address": "192.168.1.100",
  "user_agent": "HIVE-MIND-Web/1.0",
  "platform_type": "web",
  "session_id": "session-789",
  "processing_basis": "GDPR Article 20 - Right to data portability",
  "legal_basis_note": null,
  "created_at": "2026-03-09T11:00:00Z"
}
```

### Security Violation Detected

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440003",
  "user_id": null,
  "organization_id": null,
  "event_type": "brute_force_detected",
  "event_category": "security",
  "resource_type": "system",
  "resource_id": null,
  "action": "read",
  "old_value": null,
  "new_value": {
    "ipAddress": "10.0.0.50",
    "attemptCount": 10,
    "targetUsers": ["user-123", "user-456"]
  },
  "ip_address": "10.0.0.50",
  "user_agent": "python-requests/2.28.0",
  "platform_type": "api",
  "session_id": null,
  "processing_basis": "GDPR Article 6(1)(f) - Legitimate interest (security)",
  "legal_basis_note": "Automated security detection",
  "created_at": "2026-03-09T11:15:00Z"
}
```

## Query Examples

### Get User Activity Timeline

```sql
SELECT 
    event_type,
    action,
    resource_type,
    resource_id,
    ip_address,
    created_at
FROM audit_logs
WHERE user_id = 'user-123'
ORDER BY created_at DESC
LIMIT 100;
```

### Get Security Events (Last 24 Hours)

```sql
SELECT 
    event_type,
    ip_address,
    user_agent,
    created_at
FROM audit_logs
WHERE event_category = 'security'
  AND created_at >= NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC;
```

### Get Resource Audit Trail

```sql
SELECT 
    event_type,
    action,
    user_id,
    old_value,
    new_value,
    created_at
FROM audit_logs
WHERE resource_type = 'memory'
  AND resource_id = 'memory-abc'
ORDER BY created_at ASC;
```

### Compliance Report (Monthly)

```sql
SELECT 
    event_category,
    COUNT(*) as event_count,
    DATE_TRUNC('day', created_at) as event_date
FROM audit_logs
WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE)
  AND created_at < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
GROUP BY event_category, DATE_TRUNC('day', created_at)
ORDER BY event_date, event_category;
```

## Retention Policy

| Requirement | Value |
|-------------|-------|
| Minimum Retention | 7 years (NIS2/DORA) |
| Storage Type | Immutable, append-only |
| Archive Policy | Move to cold storage after 7 years |
| Deletion | Never deleted (compliance requirement) |

## Security Controls

1. **Immutability**: Logs cannot be modified after creation
2. **Access Control**: Only compliance officers can query all logs
3. **Encryption**: Encrypted at rest (LUKS2) and in transit (TLS 1.3)
4. **Integrity**: Cryptographic hashing for tamper detection
5. **Audit**: All log queries are themselves logged

## Compliance Mapping

| Regulation | Requirement | Implementation |
|------------|-------------|----------------|
| NIS2 Article 21 | Incident logging | All security events logged |
| DORA Article 16 | ICT incident reporting | Detailed event classification |
| DORA Article 17 | Logging arrangements | 7-year retention |
| GDPR Article 30 | Processing records | All data operations logged |
| GDPR Article 5 | Accountability | Complete audit trail |
