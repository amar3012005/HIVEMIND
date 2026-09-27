export async function approvePendingInput(approve: () => Promise<unknown>): Promise<{ approved: true } | { approved: false; error: string }> {
  try {
    await approve();
    return { approved: true };
  } catch (error) {
    return { approved: false, error: error instanceof Error ? error.message : "resume_failed" };
  }
}
