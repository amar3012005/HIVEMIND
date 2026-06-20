/**
 * Personio v2 normalizer — converts a validated employee record into a
 * HIVEMIND memory payload array.
 *
 * PII allowlist is enforced HERE as a second defense-in-depth gate on top of
 * the Zod schema in schema.js. Only name, role, department, workEmail, and
 * managerId survive into the output. Salary, dateOfBirth, nationalId,
 * bankAccount, address, and all other PII fields are never written.
 *
 * ESM module (core/ is "type":"module").
 */

/**
 * Normalise one validated Personio employee record into one-or-more HIVEMIND
 * memory payloads (always returns an array for SyncEngine compatibility).
 *
 * Context keys follow the SyncEngine snake_case convention used in tests
 * (org_id / user_id) as well as the camelCase form (orgId / userId) used in
 * service-layer callers — both spellings are accepted.
 *
 * @param {object} employee - Validated Personio employee (schema-parsed, camelCase).
 * @param {object} context  - Sync context supplied by the adapter / SyncEngine.
 * @param {string} [context.orgId]   - Tenant org ID (camelCase form).
 * @param {string} [context.org_id]  - Tenant org ID (snake_case form, used in tests).
 * @param {string} [context.userId]  - Owning user ID (camelCase form).
 * @param {string} [context.user_id] - Owning user ID (snake_case form, used in tests).
 * @param {string} [context.provider] - Provider key (defaults to 'personio-v2').
 * @returns {object[]} Array of memory payloads for SyncEngine ingest.
 * @throws {Error} When neither orgId nor org_id is present in context.
 */
export function normalizeEmployee(employee, context) {
  // Accept both camelCase (service layer) and snake_case (SyncEngine / tests)
  const orgId = context?.orgId || context?.org_id;
  const userId = context?.userId || context?.user_id;

  if (!orgId) {
    throw new Error(
      'normalizeEmployee: context.orgId (or context.org_id) is required for tenant isolation'
    );
  }

  // -------------------------------------------------------------------------
  // PII allowlist — ONLY these fields appear in the output.
  // Salary, dateOfBirth, nationalId, bankAccount, address, personalEmail,
  // phone, gender and all other PII fields are intentionally excluded.
  // -------------------------------------------------------------------------
  const firstName = employee.firstName || '';
  const lastName = employee.lastName || '';
  const name = [firstName, lastName].filter(Boolean).join(' ') || 'Unknown Employee';
  const role = employee.role || '';
  const department = employee.department || '';
  const workEmail = employee.workEmail || '';
  const managerId = employee.managerId != null ? employee.managerId : null;

  // Tags: non-empty allowlist values only (no nulls / empty strings)
  const tags = [name, role, department, workEmail].filter(Boolean);

  // Content: human-readable lines built only from allowlist fields
  const contentLines = [
    role && `Role: ${role}`,
    department && `Department: ${department}`,
    workEmail && `Email: ${workEmail}`,
    managerId != null && `Manager ID: ${managerId}`,
  ].filter(Boolean);

  const payload = {
    orgId,                              // REQUIRED — tenant scope for every DB write
    userId,
    provider: context?.provider || 'personio-v2',
    source_id: `personio-employee-${employee.id}`, // stable deduplication key
    title: name,
    content: contentLines.join('\n'),
    tags,
    metadata: {
      employee_id: employee.id,
      manager_id: managerId,
    },
  };

  // SyncEngine / toMemoryPayloads contract: always return an array
  return [payload];
}
