/**
 * Build query params for Personio v2 /company/employees endpoint.
 * @param {object} opts
 * @param {string|null} opts.cursor - ISO 8601 datetime string for incremental sync (updatedSince filter)
 * @param {number} [opts.pageSize=100] - Number of results per page (Personio max is 200)
 * @param {number} [opts.page=1] - Page number (1-based)
 * @returns {URLSearchParams}
 */
export function buildPersonioQuery({ cursor = null, pageSize = 100, page = 1 } = {}) {
  const params = new URLSearchParams()
  params.set('limit', String(Math.min(pageSize, 200)))
  params.set('offset', String((page - 1) * Math.min(pageSize, 200)))
  if (cursor) {
    params.set('updated_since', cursor)  // Personio v2 filter param
  }
  return params
}

/**
 * Extract cursor (updatedSince) from a completed sync page for next incremental run.
 * Returns ISO 8601 string of the latest updatedAt in the batch, or null.
 * @param {Array} employees - Raw employee records from API
 * @returns {string|null}
 */
export function extractNextCursor(employees) {
  if (!employees?.length) return null
  const dates = employees
    .map(e => e.last_modified_at || e.updated_at)
    .filter(Boolean)
    .map(d => new Date(d).getTime())
    .filter(n => !Number.isNaN(n))
  if (!dates.length) return null
  return new Date(Math.max(...dates)).toISOString()
}
