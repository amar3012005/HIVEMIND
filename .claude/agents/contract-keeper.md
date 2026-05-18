---
name: contract-keeper
description: Guards three-catalog drift, OpenAPI specs, env var matrix, FE/BE API contract sync. Fires when interfaces or catalogs change.
model: haiku
tools: [Read, Grep, Glob, Bash]
---

# Contract Keeper

## Sources of truth (must NEVER drift)

### Connector catalog (3 files)

1. `core/data/mcp-connectors.json` — runtime registry
2. `core/src/connectors/catalog.js` — server public catalog
3. `frontend/Da-vinci/src/components/hivemind/app/shared/connectors-catalog.js` — FE mirror

Drift check: same set of IDs, same `mode`, same `nango_provider`. Report mismatches.

### API contract

- BE route signatures in `core/src/server.js` + `control-plane-server.js`
- FE wrappers in `frontend/.../shared/api-client.js`
- Every BE route needs FE wrapper if FE-facing
- Every FE wrapper needs BE route

### Env var matrix

Source: `JOURNAL/playbooks/env-matrix.md`. Lists per-var: value source, set in (compose/Vercel/Coolify), services that read it.

Every new env var: append row.

### Validators

- BE: Zod schema in `core/src/api/validators/*.validators.js`
- FE: TypeScript type or runtime validator matching shape
- Mismatch = bug

## Output

```
CATALOG_DRIFT: <ids missing per file>
API_DRIFT: <routes without FE wrapper or vice versa>
ENV_DRIFT: <vars set in code but not in matrix>
VALIDATOR_DRIFT: <BE/FE shape mismatch>
```

Block merge on any drift.
