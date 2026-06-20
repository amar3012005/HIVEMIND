/**
 * Personio v2 Provider Adapter — thin orchestrator.
 *
 * Owns ONLY: Personio API transport + fetch/pagination + engine contract
 * (fetchInitial / fetchIncremental / normalize / dedupeKey).
 *
 * Delegates:
 *   - query construction → ./query-builder.js  (buildPersonioQuery, extractNextCursor)
 *   - record → payloads   → ./normalizer.js    (normalizeEmployee)
 *   - PII allowlist        → ./schema.js + normalizer (two-layer defence-in-depth)
 *
 * Auth: access token is injected by the SyncEngine via getAccessToken().
 * This adapter NEVER imports Nango directly.
 *
 * ESM module (core/ is "type":"module").
 */

import { BaseProviderAdapter } from '../../framework/provider-adapter.js';
import { PersonioEmployeesResponseSchema } from './schema.js';
import { buildPersonioQuery, extractNextCursor } from './query-builder.js';
import { normalizeEmployee } from './normalizer.js';

const PERSONIO_BASE_URL = 'https://api.personio.de';
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_RUN_CAP = 5000; // max employees per sync run

export class PersonioV2Adapter extends BaseProviderAdapter {
  constructor() {
    super({
      providerId: 'personio-v2',
      requiredScopes: [],
      defaultTags: ['personio', 'hr'],
    });
  }

  /**
   * Generate a stable deduplication key for a Personio employee record.
   * @param {{ id: number }} employee
   * @returns {string}
   */
  dedupeKey(employee) {
    return `personio-employee-${employee.id}`;
  }

  /**
   * Full backfill: fetch all employees, paginating until run-cap is reached.
   *
   * Pagination uses offset/limit (page-based). After all pages are consumed
   * (or run-cap hit), the latest updatedAt across all fetched records is
   * returned as nextCursor for future incremental runs.
   *
   * @param {{ accessToken: string, cursor: string|null, context: object }} params
   * @returns {Promise<{ records: object[], nextCursor: string|null, hasMore: boolean }>}
   */
  async fetchInitial({ accessToken, cursor, context }) {
    const runCap =
      Number(context?.config?.max_employees) > 0
        ? Number(context.config.max_employees)
        : DEFAULT_RUN_CAP;

    const records = [];
    let page = 1;
    let continueLoop = true;

    while (continueLoop) {
      const params = buildPersonioQuery({ page, pageSize: DEFAULT_PAGE_SIZE });

      const response = await fetch(
        `${PERSONIO_BASE_URL}/v2/company/employees?${params.toString()}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'X-Personio-Partner-ID': 'HIVEMIND',
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(30_000),
        }
      );

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `Personio API error ${response.status}: ${text.slice(0, 200)}`
        );
      }

      const raw = await response.json();
      const parsed = PersonioEmployeesResponseSchema.safeParse(raw);
      const employees = parsed.success ? parsed.data.data : (raw.data ?? []);

      records.push(...employees);

      // Enforce run-cap: trim excess and stop
      if (records.length >= runCap) {
        records.splice(runCap);
        continueLoop = false;
        break;
      }

      // Determine if more pages exist via either cursor or total_pages
      const nextPageCursor = raw?.meta?.next_cursor || null;
      const totalPages =
        raw?.meta?.total_pages ||
        raw?.metadata?.total_pages ||
        null;

      const hasNextPage =
        // cursor-based pagination: a next_cursor value signals more pages
        (nextPageCursor != null && nextPageCursor !== '') ||
        // page-based pagination: current page < declared total
        (totalPages != null && page < totalPages);

      if (!hasNextPage || employees.length === 0) {
        continueLoop = false;
      } else {
        page++;
      }
    }

    const nextCursor = extractNextCursor(records);
    return { records, nextCursor, hasMore: false };
  }

  /**
   * Incremental sync: fetch only employees updated since the last cursor.
   *
   * Cursor is an ISO 8601 datetime string (updatedSince). Returns a fresh
   * cursor (latest updatedAt from this batch) for the next incremental tick.
   *
   * @param {{ accessToken: string, cursor: string, context: object }} params
   * @returns {Promise<{ records: object[], nextCursor: string|null, hasMore: boolean }>}
   */
  async fetchIncremental({ accessToken, cursor, context }) {
    const records = [];
    let page = 1;
    let hasMore = true;
    const runCap =
      Number(context?.config?.max_employees) > 0
        ? Number(context.config.max_employees)
        : DEFAULT_RUN_CAP;

    while (hasMore && records.length < runCap) {
      const params = buildPersonioQuery({ cursor, pageSize: DEFAULT_PAGE_SIZE, page });

      const response = await fetch(
        `${PERSONIO_BASE_URL}/v2/company/employees?${params.toString()}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'X-Personio-Partner-ID': 'HIVEMIND',
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(30_000),
        }
      );

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `Personio incremental error ${response.status}: ${text.slice(0, 200)}`
        );
      }

      const raw = await response.json();
      const parsed = PersonioEmployeesResponseSchema.safeParse(raw);
      const employees = parsed.success ? parsed.data.data : (raw.data ?? []);
      records.push(...employees);

      const totalPages =
        raw?.metadata?.total_pages || raw?.meta?.total_pages || 1;
      hasMore = page < totalPages && records.length < runCap;
      page++;
    }

    if (records.length > runCap) records.splice(runCap);

    // Derive next cursor from the batch; fall back to the incoming cursor so
    // subsequent runs don't regress to a full scan.
    const nextCursor = extractNextCursor(records) || cursor || null;

    return { records, nextCursor, hasMore: false };
  }

  /**
   * Transform one employee record (or an array of records) into HIVEMIND
   * memory payloads. Delegates PII stripping to normalizeEmployee().
   *
   * Accepts both a single employee object and an array for SyncEngine compat.
   *
   * @param {object|object[]} employees - Raw/validated employee record(s)
   * @param {object} context            - Sync context with orgId / org_id
   * @returns {object[]}                  Array of memory payloads
   */
  normalize(employees, context) {
    const list = Array.isArray(employees) ? employees : [employees];
    return list.flatMap((emp) => normalizeEmployee(emp, context));
  }
}

export default PersonioV2Adapter;
