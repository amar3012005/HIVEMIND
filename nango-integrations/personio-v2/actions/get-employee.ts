import type { NangoAction } from '@nangohq/node'

interface GetEmployeeInput {
  id: number
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

export default async function runAction(nango: NangoAction, input: GetEmployeeInput): Promise<Employee> {
  const response = await nango.get({
    endpoint: `/v2/company/employees/${input.id}`,
  })

  if (!response.ok) {
    throw new Error(`Personio API error ${response.status} for employee ${input.id}`)
  }

  const body = await response.json() as { data: Record<string, unknown> }
  return mapEmployee(body.data)
}
