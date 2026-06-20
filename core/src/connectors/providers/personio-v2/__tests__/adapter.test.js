/**
 * RED tests for T1: PersonioV2Adapter.
 *
 * The adapter file (../adapter.js) does NOT exist yet. Tests use dynamic
 * imports with fallback so each test fails individually with a clear message
 * rather than crashing the whole suite at import time.
 *
 * Expected RED failure modes:
 *   - "adapter.js does not exist yet" when the file is missing
 *   - Assertion failures once the file exists but behaviour is wrong
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

// ---------------------------------------------------------------------------
// Mock fetch — Personio REST API calls must never hit the network in tests
// ---------------------------------------------------------------------------
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const FAKE_ACCESS_TOKEN = 'test-bearer-token';
const ORG_ID = 'org-test-001';
const USER_ID = 'user-test-001';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_PATH = path.resolve(__dirname, '../adapter.js');
const SCHEMA_PATH = path.resolve(__dirname, '../schema.js');

/** Minimal valid Personio employee record (v2 shape). */
function makeEmployee(overrides = {}) {
  return {
    id: 12345,
    firstName: 'Ada',
    lastName: 'Lovelace',
    role: 'Engineer',
    department: 'Engineering',
    workEmail: 'ada@example.com',
    managerId: 9999,
    // PII fields that must be stripped:
    salary: 120000,
    dateOfBirth: '1990-01-01',
    nationalId: 'DE-123456',
    bankAccount: { iban: 'DE89 3704 0044 0532 0130 00' },
    ...overrides,
  };
}

function makePage(employees, nextCursor = null) {
  return {
    data: employees,
    meta: { next_cursor: nextCursor },
  };
}

/**
 * Dynamically import the adapter. Throws with a clear RED message if missing.
 */
async function loadAdapter() {
  if (!fs.existsSync(ADAPTER_PATH)) {
    throw new Error('adapter.js does not exist yet — RED state confirmed');
  }
  const mod = await import(ADAPTER_PATH);
  const AdapterClass = mod.PersonioV2Adapter || mod.default;
  if (!AdapterClass) {
    throw new Error('adapter.js exists but exports no PersonioV2Adapter class — RED state');
  }
  return AdapterClass;
}

// ---------------------------------------------------------------------------
// T1a: fetchInitial paginates and stops at run-cap
// ---------------------------------------------------------------------------
describe('PersonioV2Adapter.fetchInitial', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T1a-1: paginates through multiple pages until run-cap is reached', async () => {
    const AdapterClass = await loadAdapter();

    const page1 = makePage(Array.from({ length: 100 }, (_, i) => makeEmployee({ id: i + 1 })), 'cursor-page-2');
    const page2 = makePage(Array.from({ length: 100 }, (_, i) => makeEmployee({ id: i + 101 })), 'cursor-page-3');

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => page1 })
      .mockResolvedValueOnce({ ok: true, json: async () => page2 });

    const adapter = new AdapterClass();
    const result = await adapter.fetchInitial({
      accessToken: FAKE_ACCESS_TOKEN,
      cursor: null,
      context: { user_id: USER_ID, org_id: ORG_ID, config: { max_employees: 150 } },
    });

    // run-cap of 150 → should stop after page 1 (100 records) + partial page 2
    expect(result.records.length).toBeLessThanOrEqual(200);
    expect(result).toHaveProperty('nextCursor');
    expect(result).toHaveProperty('hasMore');
    // With cap 150 and 100 in page 1, should stop at or before 150
    expect(result.records.length).toBeLessThanOrEqual(150);
  });

  it('T1a-2: returns empty records and hasMore=false when Personio returns no data', async () => {
    const AdapterClass = await loadAdapter();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makePage([], null),
    });

    const adapter = new AdapterClass();
    const result = await adapter.fetchInitial({
      accessToken: FAKE_ACCESS_TOKEN,
      cursor: null,
      context: { user_id: USER_ID, org_id: ORG_ID },
    });

    expect(result.records).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T1b: fetchIncremental uses updatedSince cursor
// ---------------------------------------------------------------------------
describe('PersonioV2Adapter.fetchIncremental', () => {
  beforeEach(() => vi.clearAllMocks());

  it('T1b-1: passes updatedSince cursor to Personio API call', async () => {
    const AdapterClass = await loadAdapter();

    const updatedSince = '2026-06-01T00:00:00Z';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makePage([makeEmployee()], null),
    });

    const adapter = new AdapterClass();
    await adapter.fetchIncremental({
      accessToken: FAKE_ACCESS_TOKEN,
      cursor: updatedSince,
      context: { user_id: USER_ID, org_id: ORG_ID },
    });

    // The fetch call URL must reference the updatedSince value
    expect(mockFetch).toHaveBeenCalled();
    const calledUrl = mockFetch.mock.calls[0][0];
    // Date portion must appear in the URL (encoded or raw)
    const datePart = '2026-06-01';
    const encodedDate = encodeURIComponent(datePart);
    const urlStr = typeof calledUrl === 'string' ? calledUrl : calledUrl.toString();
    expect(urlStr.includes(datePart) || urlStr.includes(encodedDate)).toBe(true);
  });

  it('T1b-2: returns a nextCursor for subsequent incremental runs', async () => {
    const AdapterClass = await loadAdapter();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makePage([makeEmployee()], '2026-06-15T00:00:00Z'),
    });

    const adapter = new AdapterClass();
    const result = await adapter.fetchIncremental({
      accessToken: FAKE_ACCESS_TOKEN,
      cursor: '2026-06-01T00:00:00Z',
      context: { user_id: USER_ID, org_id: ORG_ID },
    });

    expect(result.nextCursor).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// T1c: dedupeKey stability
// ---------------------------------------------------------------------------
describe('PersonioV2Adapter.dedupeKey', () => {
  it('T1c-1: returns stable string for same employee ID across calls', async () => {
    const AdapterClass = await loadAdapter();
    const adapter = new AdapterClass();
    const emp = makeEmployee({ id: 42 });

    const key1 = adapter.dedupeKey(emp);
    const key2 = adapter.dedupeKey(emp);

    expect(key1).toBe(key2);
    expect(typeof key1).toBe('string');
    expect(key1.length).toBeGreaterThan(0);
  });

  it('T1c-2: returns different keys for different employee IDs', async () => {
    const AdapterClass = await loadAdapter();
    const adapter = new AdapterClass();

    expect(adapter.dedupeKey(makeEmployee({ id: 1 }))).not.toBe(
      adapter.dedupeKey(makeEmployee({ id: 2 }))
    );
  });

  it('T1c-3: dedupeKey includes employee ID so it is content-addressable', async () => {
    const AdapterClass = await loadAdapter();
    const adapter = new AdapterClass();
    const key = adapter.dedupeKey(makeEmployee({ id: 777 }));
    expect(key).toMatch(/777/);
  });
});

// ---------------------------------------------------------------------------
// T1d-PII: normalize strips PII fields
// ---------------------------------------------------------------------------
describe('PersonioV2Adapter.normalize — PII stripping', () => {
  it('T1d-1: salary is NOT present in any normalized payload', async () => {
    const AdapterClass = await loadAdapter();
    const adapter = new AdapterClass();
    const payloads = adapter.normalize(makeEmployee(), { user_id: USER_ID, org_id: ORG_ID });

    const flat = JSON.stringify(payloads);
    expect(flat).not.toMatch(/salary/i);
    expect(flat).not.toMatch(/120000/);
  });

  it('T1d-2: dateOfBirth is NOT present in any normalized payload', async () => {
    const AdapterClass = await loadAdapter();
    const adapter = new AdapterClass();
    const payloads = adapter.normalize(makeEmployee(), { user_id: USER_ID, org_id: ORG_ID });

    const flat = JSON.stringify(payloads);
    expect(flat).not.toMatch(/dateOfBirth|date_of_birth/i);
    expect(flat).not.toMatch(/1990-01-01/);
  });

  it('T1d-3: nationalId is NOT present in any normalized payload', async () => {
    const AdapterClass = await loadAdapter();
    const adapter = new AdapterClass();
    const payloads = adapter.normalize(makeEmployee(), { user_id: USER_ID, org_id: ORG_ID });

    const flat = JSON.stringify(payloads);
    expect(flat).not.toMatch(/nationalId|national_id/i);
    expect(flat).not.toMatch(/DE-123456/);
  });

  it('T1d-4: bankAccount is NOT present in any normalized payload', async () => {
    const AdapterClass = await loadAdapter();
    const adapter = new AdapterClass();
    const payloads = adapter.normalize(makeEmployee(), { user_id: USER_ID, org_id: ORG_ID });

    const flat = JSON.stringify(payloads);
    expect(flat).not.toMatch(/bankAccount|bank_account|iban/i);
  });
});

// ---------------------------------------------------------------------------
// T1d-ALLOWLIST: normalize includes ONLY allowlist fields
// ---------------------------------------------------------------------------
describe('PersonioV2Adapter.normalize — allowlist fields present', () => {
  it('T1d-5: normalized payload includes firstName', async () => {
    const AdapterClass = await loadAdapter();
    const adapter = new AdapterClass();
    const payloads = adapter.normalize(makeEmployee({ firstName: 'Ada' }), { user_id: USER_ID, org_id: ORG_ID });
    expect(JSON.stringify(payloads)).toMatch(/Ada/);
  });

  it('T1d-6: normalized payload includes lastName', async () => {
    const AdapterClass = await loadAdapter();
    const adapter = new AdapterClass();
    const payloads = adapter.normalize(makeEmployee({ lastName: 'Lovelace' }), { user_id: USER_ID, org_id: ORG_ID });
    expect(JSON.stringify(payloads)).toMatch(/Lovelace/);
  });

  it('T1d-7: normalized payload includes role', async () => {
    const AdapterClass = await loadAdapter();
    const adapter = new AdapterClass();
    const payloads = adapter.normalize(makeEmployee({ role: 'SRE' }), { user_id: USER_ID, org_id: ORG_ID });
    expect(JSON.stringify(payloads)).toMatch(/SRE/);
  });

  it('T1d-8: normalized payload includes department', async () => {
    const AdapterClass = await loadAdapter();
    const adapter = new AdapterClass();
    const payloads = adapter.normalize(makeEmployee({ department: 'Infra' }), { user_id: USER_ID, org_id: ORG_ID });
    expect(JSON.stringify(payloads)).toMatch(/Infra/);
  });

  it('T1d-9: normalized payload includes workEmail', async () => {
    const AdapterClass = await loadAdapter();
    const adapter = new AdapterClass();
    const payloads = adapter.normalize(makeEmployee({ workEmail: 'ada@corp.io' }), { user_id: USER_ID, org_id: ORG_ID });
    expect(JSON.stringify(payloads)).toMatch(/ada@corp\.io/);
  });

  it('T1d-10: normalized payload includes managerId', async () => {
    const AdapterClass = await loadAdapter();
    const adapter = new AdapterClass();
    const payloads = adapter.normalize(makeEmployee({ managerId: 888 }), { user_id: USER_ID, org_id: ORG_ID });
    expect(JSON.stringify(payloads)).toMatch(/888/);
  });
});

// ---------------------------------------------------------------------------
// T1d-TENANT: normalize includes orgId in every payload
// ---------------------------------------------------------------------------
describe('PersonioV2Adapter.normalize — tenant scoping', () => {
  it('T1d-11: every normalized payload contains orgId', async () => {
    const AdapterClass = await loadAdapter();
    const adapter = new AdapterClass();
    const payloads = adapter.normalize(makeEmployee(), { user_id: USER_ID, org_id: 'org-ACME' });

    expect(Array.isArray(payloads)).toBe(true);
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      expect(JSON.stringify(payload)).toMatch(/org-ACME/);
    }
  });
});

// ---------------------------------------------------------------------------
// T1e: Zod schema rejects malformed employee
// ---------------------------------------------------------------------------
describe('PersonioV2Adapter — schema validation', () => {
  it('T1e-1: Zod schema rejects employee missing required id field', async () => {
    if (!fs.existsSync(SCHEMA_PATH)) {
      throw new Error('schema.js does not exist yet — RED state confirmed');
    }

    const schemaModule = await import(SCHEMA_PATH);
    const Schema = schemaModule.PersonioEmployeeSchema || schemaModule.default;
    if (!Schema) throw new Error('schema.js exports no PersonioEmployeeSchema — RED state');

    const result = Schema.safeParse({ firstName: 'Ada' /* missing id */ });
    expect(result.success).toBe(false);
  });

  it('T1e-2: Zod schema rejects employee with non-numeric id', async () => {
    if (!fs.existsSync(SCHEMA_PATH)) {
      throw new Error('schema.js does not exist yet — RED state confirmed');
    }

    const schemaModule = await import(SCHEMA_PATH);
    const Schema = schemaModule.PersonioEmployeeSchema || schemaModule.default;
    if (!Schema) throw new Error('schema.js exports no PersonioEmployeeSchema — RED state');

    const result = Schema.safeParse({ id: 'not-a-number', firstName: 'Ada', workEmail: 'ada@x.com' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T1f: Adapter does NOT import Nango directly
// ---------------------------------------------------------------------------
describe('PersonioV2Adapter — no Nango import', () => {
  it('T1f-1: adapter.js source does not contain a direct Nango import', () => {
    if (!fs.existsSync(ADAPTER_PATH)) {
      throw new Error('adapter.js does not exist yet — RED state confirmed');
    }

    const source = fs.readFileSync(ADAPTER_PATH, 'utf8');

    // Must not import @nangohq/node, @nangohq/sdk, or bare 'nango'
    expect(source).not.toMatch(/@nangohq\/(node|sdk)/);
    expect(source).not.toMatch(/from ['"]nango['"]/);
    expect(source).not.toMatch(/require\(['"]nango['"]\)/);
  });
});
