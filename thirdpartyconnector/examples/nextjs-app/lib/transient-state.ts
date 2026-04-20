type OauthTransientState = {
  state: string;
  codeVerifier: string;
  createdAt: number;
};

const TTL_MS = 10 * 60 * 1000;
const stateStore = new Map<string, OauthTransientState>();

export function putTransientState(record: OauthTransientState): void {
  stateStore.set(record.state, record);
}

export function consumeTransientState(state: string): OauthTransientState | null {
  const record = stateStore.get(state) || null;
  stateStore.delete(state);
  if (!record) return null;
  if (Date.now() - record.createdAt > TTL_MS) return null;
  return record;
}
