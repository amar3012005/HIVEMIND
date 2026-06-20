import type { NangoAction } from '@nangohq/node'

interface GetEmployeesInput {
  updatedSince?: string
  limit?: number
  offset?: number
}

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

export default async function runAction(nango: NangoAction, input: GetEmployeesInput): Promise<Employee[]> {
  const params = new URLSearchParams()
  if (input.updatedSince) params.set('updated_since', input.updatedSince)
  params.set('limit', String(Math.min(input.limit ?? 100, 200)))
  params.set('offset', String(input.offset ?? 0))

  const response = await nango.get({
    endpoint: `/v2/company/employees?${params.toString()}`,
  })

  if (!response.ok) {
    throw new Error(`Personio API error: ${response.status}`)
  }

  const body = await response.json() as { data: Record<string, unknown>[] }
  return (body.data ?? []).map(mapEmployee)
}
