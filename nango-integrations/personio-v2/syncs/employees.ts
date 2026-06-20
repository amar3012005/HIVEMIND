import type { NangoSync } from '@nangohq/node'

interface Employee {
  id: number
  firstName: string
  lastName: string
  workEmail: string
  role: string
  department: string
  managerId: number
}

function mapEmployee(raw: Record<string, unknown>): Employee {
  return {
    id: raw['id'] as number,
    firstName: (raw['first_name'] as string) ?? '',
    lastName: (raw['last_name'] as string) ?? '',
    workEmail: (raw['email'] as string) ?? '',
    role: (raw['position'] as string) ?? '',
    department: ((raw['department'] as Record<string, unknown>)?.['name'] as string) ?? '',
    managerId: ((raw['manager'] as Record<string, unknown>)?.['id'] as number) ?? 0,
  }
}

const PAGE_SIZE = 100
const MAX_PAGES = 50  // cap: never fetch more than 5000 employees per sync run

export default async function runSync(nango: NangoSync): Promise<void> {
  let offset = 0
  let page = 0

  while (page < MAX_PAGES) {
    const isIncremental = nango.lastSyncDate != null
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
    })
    if (isIncremental && nango.lastSyncDate) {
      params.set('updated_since', nango.lastSyncDate.toISOString())
    }

    const response = await nango.get({
      endpoint: `/v2/company/employees?${params.toString()}`,
    })

    if (!response.ok) {
      throw new Error(`Personio sync error: ${response.status}`)
    }

    const body = await response.json() as { data: Record<string, unknown>[] }
    const employees = (body.data ?? []).map(mapEmployee)

    if (!employees.length) break

    await nango.batchSave(employees, 'Employee')

    if (employees.length < PAGE_SIZE) break  // last page
    offset += PAGE_SIZE
    page++
  }
}
