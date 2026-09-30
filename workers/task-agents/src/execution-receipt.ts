/** Use the native plan ledger as the completion receipt when every required
 * content step has already been verified. Artifact steps are completed only
 * after the Workflow saves their actual receipt. */
export function verifiedExecutionReceipt(
  report: string,
  completedTaskIds: readonly number[],
  requiredTaskIds: readonly number[],
): { report: string; completedTaskIds: number[] } | null {
  if (!report.trim() || !requiredTaskIds.length) return null;
  const completed = new Set(completedTaskIds);
  if (!requiredTaskIds.every((id) => completed.has(id))) return null;
  return { report, completedTaskIds: [...completed] };
}
