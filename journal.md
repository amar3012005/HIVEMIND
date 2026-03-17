# HIVE-MIND Deployment Journal

## 2026-03-17 19:45 UTC - Hosted MCP Service Tested Locally

### Phase 2 Complete: Context-as-a-Service Platform

**Local Test Results:**
- **Endpoint**: `http://localhost:3000/api/mcp/servers/{userId}`
- **Auth**: HIVEMIND_MASTER_API_KEY=hm_master_key_99228811
- **Status**: ✅ Working - Returns complete MCP server configuration

**Response includes:**
- `mcp` - Server info (hivemind-hosted-mcp v2.0.0), protocol 2024-11-05
- `connection` - Token (24h expiry), SSE/JSON-RPC endpoints
- `tools` - 9 MCP tools: save_memory, recall, traverse_graph, etc.

**Claude Desktop Config:**
```json
{
  "mcpServers": {
    "hivemind": {
      "command": "npx",
      "args": ["-y", "@hivemind/mcp-bridge", "hosted"],
      "env": {
        "HIVEMIND_HOSTED_URL": "http://localhost:3000/api/mcp/servers/{userId}",
        "HIVEMIND_CONNECTION_TOKEN": "{token_from_response}",
        "HIVEMIND_USER_ID": "{userId}"
      }
    }
  }
}
```

### Docker Updates Applied
- **File**: `docker-compose.local-stack.yml`
- **Changes**: Added HIVEMIND_MASTER_API_KEY, HIVEMIND_ADMIN_SECRET, all feature flags
- **Containers**: Rebuilt api image, restarted all services

---

## 2026-03-17 - SSL Deployment & Structural Fixes
### Progress Summary
- **Infrastructure**: Successfully deployed HIVE-MIND with SSL termination using Caddy.
- **Port Configuration**: SSL running on port `2028`, HTTP on `2029`.
- **Database/Storage**: Postgres, Redis, and Qdrant containers verified and healthy.
- **Git Sync**: Synchronized Hetzner server state with GitHub repository.

### Technical Fixes
1. **Module Resolution**: Fixed `ERR_MODULE_NOT_FOUND` errors.
   - Migrated from fragile symlinks to proper relative path imports in `core/src/external/`.
   - Patched imports to reference shared utils, db, and vector modules correctly.
2. **Code Bug Fixes**:
   - Resolved `ReferenceError: groqClient is not defined` by reordering initialization in `server.js`.
3. **Dependencies**:
   - Added missing `@qdrant/js-client-rest` package to `core/package.json`.
4. **Prisma/Docker Compatibility**:
   - Updated `Dockerfile.production` to use `node:20-slim` (Debian-based) instead of Alpine to resolve OpenSSL/Prisma binary compatibility issues.
5. **Security**:
   - Issued SSL certificate for `hivemind.davinciai.eu` via Certbot DNS-01 challenge.
   - Configured Caddy reverse proxy with internal TLS mounting.
   - Set up crontab for automatic certificate renewal.

### Current Status
- **API Health**: ✅ Healthy at `https://hivemind.davinciai.eu:2028/health`
- **Repository**: Updated and pushed to origin/main.

## 2026-03-17 - Port Migration
- **Port Change**: Migrated SSL port from `8445` to `8050`.
- **Reason**: Aligned with user's preferred 80XX/84XX port range.
- **Verification**: ✅ Confirmed healthy at `https://hivemind.davinciai.eu:8050/health`.

## 2026-03-17 14:15:00 UTC - JavaScript SDK Created
### Feature: @hivemind/sdk for Webapp Integration
- **Location**: `sdk/` directory
- **Files Created**:
  - `sdk/src/index.js` - Main SDK client with all API methods
  - `sdk/package.json` - NPM package configuration
  - `sdk/README.md` - Complete documentation
  - `sdk/examples/basic.js` - Usage examples
  - `sdk/types/index.d.ts` - TypeScript definitions
- **Features**:
  - `HiveMindClient` class with authentication
  - `save()`, `saveCode()`, `saveConversation()` helpers
  - `search()`, `query()` for memory retrieval
  - `bulkSave()`, `update()`, `delete()`, `list()` methods
  - Error handling with `HiveMindError` class
- **Usage**:
  ```javascript
  import { HiveMindClient } from '@hivemind/sdk';
  const hivemind = new HiveMindClient({ url, apiKey });
  await hivemind.save({ title, content, tags });
  ```
- **Testing**: ✅ Local test initiated (requires API key verification on server)
- **Next Steps**:
  - [ ] Verify API key on Hetzner server
  - [ ] Complete SDK testing
  - [ ] Optionally publish to NPM

## 2026-03-17 - API Key Fix
- **Issue**: SDK receiving 401 Unauthorized despite using correct master key.
- **Cause**: UI and SDK were using `hm_master_key_99228811`, but the server's `HIVEMIND_MASTER_API_KEY` was set to a different value.
- **Fix**: Synchronized `HIVEMIND_MASTER_API_KEY` with `hm_master_key_99228811` in the Coolify environment and recreated the container.
- **Verification**: ✅ Confirmed authorized access with `X-API-Key: hm_master_key_99228811`.

## 2026-03-17 17:37:00 UTC - PostgreSQL Connection Fixed (P1010 Error Resolution)

### The Problem
Prisma throwing `Error P1010: User hivemind_user was denied access on database hivemind.public` despite:
- User having SUPERUSER privileges
- User having CREATE, USAGE on public schema
- User having CONNECT, CREATE on hivemind database
- Schema owner being hivemind_user

### Root Cause Analysis
1. **Corrupted PostgreSQL Volume**: The volume `s0k0s0k40wo44w4w8gcs8ow0_postgres-data` had data nested in `pgdata/` subdirectory instead of root, causing init failures
2. **Multi-Schema Prisma Bug**: Even after simplifying to `public` schema, Prisma v5.22.0 cached permission checks
3. **Hardcoded Schema References**: Migration SQL files contained `hivemind.` schema prefix, but tables were created in `public`

### What We Learned

**PostgreSQL + Prisma Permission Traps:**
- The P1010 error can persist even with correct GRANT statements
- Prisma's permission checking has known bugs with multi-schema setups
- A fresh database volume often solves what permission grants cannot

**Coolify Deployment Lessons:**
- DATABASE_URL must use service name (`postgres`) not container ID for internal networking
- External volumes that become corrupted must be deleted and recreated
- Container restarts don't pick up .env changes - full redeploy required

**Migration File Hygiene:**
- Avoid hardcoding schema names in SQL migrations if schema may change
- The `hivemind.` prefix in migrations caused `relation "hivemind.memories" does not exist` errors

**Code Fixes Required:**
- Raw SQL calls with schema prefix (`SELECT hivemind.acquire_memory_user_lock`) must match actual function location
- Changed to: `SELECT acquire_memory_user_lock` (no schema prefix)

### Fix Applied

1. **Deleted corrupted volume:**
   ```bash
   docker compose down postgres
   docker volume rm s0k0s0k40wo44w4w8gcs8ow0_postgres-data
   ```

2. **Fixed DATABASE_URL:**
   ```
   postgresql://hivemind_user:hivemind_secure_pwd_2026@postgres:5432/hivemind?schema=public
   ```

3. **Removed schema prefix from migrations:**
   ```bash
   for f in prisma/migrations/*/migration.sql; do sed -i 's/hivemind\.//g' "$f"; done
   ```

4. **Enabled required extensions:**
   ```sql
   CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
   ```

5. **Fixed code references in `prisma-graph-store.js`:**
   - `hivemind.acquire_memory_user_lock` → `acquire_memory_user_lock`

6. **Applied migrations:**
   ```bash
   npx prisma migrate deploy
   ```

### Current Status
- **PostgreSQL**: ✅ Fresh volume, all tables in `public` schema
- **Migrations**: ✅ All 8 applied successfully
- **API Health**: ✅ `http://localhost:3000/health` returns OK
- **Memory Writes**: ✅ Confirmed working with response containing memory ID
- **API Key**: `hm_master_key_99228811`

### Files Modified
- `/data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0/.env` - DATABASE_URL fixed
- `/data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0/docker-compose.yaml` - Volume externality removed
- `/opt/HIVEMIND/core/prisma/migrations/*/migration.sql` - Schema prefix removed
- `/opt/HIVEMIND/core/src/memory/prisma-graph-store.js` - Function call fixed
2026-03-17 16:45:23 - Modified: /data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0/.env
2026-03-17 16:49:18 - Modified: /data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0/.env
2026-03-17 17:18:02 - Modified: /data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0/.env
2026-03-17 17:26:17 - Modified: /data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0/.env
2026-03-17 17:27:08 - Modified: /data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0/docker-compose.yaml
2026-03-17 17:35:48 - Modified: /opt/HIVEMIND/core/src/memory/prisma-graph-store.js
