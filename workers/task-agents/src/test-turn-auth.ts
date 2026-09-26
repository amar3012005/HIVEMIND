export type TestTurnAuthorization = { allowed: true } | { allowed: false; status: 401 | 503; error: string };

export function authorizeTestTurn(configured: string | undefined, supplied: string | null): TestTurnAuthorization {
  if (!configured) return { allowed: false, status: 503, error: "test_turn_disabled" };
  if (!supplied || !constantTimeEqual(supplied, configured)) {
    return { allowed: false, status: 401, error: "unauthorized" };
  }
  return { allowed: true };
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
