type Pin = { playbookId: string; snapshot: string } | null;

/** The immutable method for a WorkRun wins over a predecessor lookup on replay. */
export function taskPlaybookSnapshot(id: string, current: Pin, previous: Pin, continuing: boolean, fresh: string): string {
  if (current) {
    if (current.playbookId !== id) throw new Error("run_playbook_conflict");
    if (!current.snapshot) throw new Error("pinned_playbook_unavailable");
    return current.snapshot;
  }
  if (continuing) {
    if (!previous || previous.playbookId !== id || !previous.snapshot) throw new Error("continuation_playbook_unavailable");
    return previous.snapshot;
  }
  return fresh;
}
