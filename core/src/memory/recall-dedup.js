export function dedupeMemoriesById(memories = []) {
  const seen = new Set();
  return memories.filter((memory) => {
    const id = memory?.id || memory?.memory?.id;
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
