/**
 * Personio v2 connector — Zod schemas.
 *
 * Source of truth for the shape of a raw Personio v2 employee API response.
 *
 * PII ALLOWLIST — only these fields survive the parse boundary:
 *   firstName, lastName, role, department, workEmail, managerId
 *
 * All other PII fields (salary, dateOfBirth, nationalId, bankAccount,
 * address, personalEmail, phone, gender, …) are stripped at parse time
 * via .strip() (Zod default mode — unknown keys are dropped).
 *
 * NO other module should read raw Personio API JSON. Always pipe through
 * PersonioEmployeeSchema.parse / PersonioEmployeeSchema.safeParse first.
 */

import { z } from 'zod';

/**
 * Raw Personio v2 single-employee object shape.
 *
 * Zod strips unknown keys by default (.strip()), enforcing the PII allowlist:
 * any field not declared here is silently discarded when parsing API responses.
 *
 * Required field:
 *   - id (number) — Personio internal employee ID, used as deduplication key.
 *
 * Optional allowlisted fields (all PII-safe for memory storage):
 *   - firstName    — given name
 *   - lastName     — family name
 *   - role         — job role / title
 *   - department   — department name (flat string, v2 API)
 *   - workEmail    — work email address only (personal email excluded)
 *   - managerId    — numeric ID of the employee's manager
 */
export const PersonioEmployeeSchema = z
  .object({
    id: z.number(),
    // PII allowlist — only these fields reach the memory layer
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    role: z.string().optional(),
    department: z.string().optional(),
    workEmail: z.string().email().optional(),
    managerId: z.number().optional(),
  })
  .strip(); // explicit: unknown keys (salary, dateOfBirth, nationalId, bankAccount, …) are dropped

/**
 * Personio v2 list-employees cursor-paginated response wrapper.
 *
 *   GET /v2/company/employees?limit=…&cursor=…
 *   → { data: [...], meta: { next_cursor: "…" | null } }
 */
export const PersonioEmployeesResponseSchema = z.object({
  data: z.array(PersonioEmployeeSchema),
  meta: z
    .object({
      next_cursor: z.string().nullable().optional(),
      total_elements: z.number().optional(),
      current_page: z.number().optional(),
      total_pages: z.number().optional(),
    })
    .optional(),
});

/**
 * Parse a raw employee object, enforcing the PII allowlist.
 * Throws ZodError on invalid input (e.g., missing `id`).
 *
 * @param {unknown} raw
 * @returns {z.infer<typeof PersonioEmployeeSchema>}
 */
export function parseEmployee(raw) {
  return PersonioEmployeeSchema.parse(raw);
}

/**
 * Non-throwing variant — use when a single malformed employee record should
 * be skipped rather than failing the whole sync.
 *
 * @param {unknown} raw
 * @returns {import('zod').SafeParseReturnType<unknown, z.infer<typeof PersonioEmployeeSchema>>}
 */
export function safeParseEmployee(raw) {
  return PersonioEmployeeSchema.safeParse(raw);
}

/**
 * Parse the full Personio v2 list-employees API response.
 * Throws ZodError on structural mismatch.
 *
 * @param {unknown} raw
 * @returns {z.infer<typeof PersonioEmployeesResponseSchema>}
 */
export function parseEmployeesResponse(raw) {
  return PersonioEmployeesResponseSchema.parse(raw);
}
