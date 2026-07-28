const CAPABILITY_ID_RE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

export class CapabilityRegistry {
  constructor(manifests = []) {
    this.manifests = new Map();
    for (const manifest of manifests) this.register(manifest);
  }

  register(manifest) {
    const id = String(manifest?.id || '');
    const version = String(manifest?.version || '');
    if (!CAPABILITY_ID_RE.test(id) || !VERSION_RE.test(version)) {
      throw new Error(`Invalid capability manifest: ${id}@${version}`);
    }
    const key = `${id}@${version}`;
    if (this.manifests.has(key)) throw new Error(`Duplicate capability: ${key}`);
    this.manifests.set(key, Object.freeze({ ...manifest, id, version }));
    return this.manifests.get(key);
  }

  resolve(reference) {
    const exact = this.manifests.get(String(reference || ''));
    if (exact) return exact;
    const candidates = [...this.manifests.values()].filter((item) => item.id === reference);
    return candidates.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0] || null;
  }

  list({ room } = {}) {
    return [...this.manifests.values()].filter((item) => !room || item.rooms?.includes(room));
  }
}

