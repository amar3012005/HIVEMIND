/** Use the native plan ledger as the completion receipt when every required
 * content step has already been verified. Artifact steps are completed only
 * after the Workflow saves their actual receipt. */
export function verifiedExecutionReceipt(
  report: string,
  completedTaskIds: readonly number[],
  requiredTaskIds: readonly number[],
  deferredTaskIds: readonly number[] = [],
  deliverableReady = true,
): { report: string; completedTaskIds: number[] } | null {
  if (!report.trim() || !requiredTaskIds.length || !deliverableReady) return null;
  const completed = new Set(completedTaskIds);
  if (!requiredTaskIds.every((id) => completed.has(id))) return null;
  // Deferred IDs are only projected into the pending receipt. The Workflow
  // still validates the report and saves the artifact before marking them.
  return { report, completedTaskIds: [...new Set([...completed, ...deferredTaskIds])] };
}
