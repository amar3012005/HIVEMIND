export interface RoomTicket {
  v: 1;
  orgId: string;
  userId: string;
  agentName: string;
  expiresAt: number;
}

export async function verifyRoomTicket(token: string, secret: string, agentName: string, now = Date.now()): Promise<RoomTicket | null> {
  if (!token || !secret) return null;
  const [encoded, signed, extra] = token.split(".");
  if (!encoded || !signed || extra) return null;
  try {
    const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("HMAC", key, decode(signed), new TextEncoder().encode(encoded))) return null;
    const value = JSON.parse(new TextDecoder().decode(decode(encoded))) as Partial<RoomTicket>;
    if (value.v !== 1 || value.agentName !== agentName || !Number.isFinite(value.expiresAt)
      || Number(value.expiresAt) <= now || Number(value.expiresAt) > now + 120_000
      || !/^[0-9a-f-]{36}$/i.test(value.orgId || "") || !/^[0-9a-f-]{36}$/i.test(value.userId || "")
      || !agentName.startsWith(`session-${value.orgId}-`)) return null;
    return value as RoomTicket;
  } catch {
    return null;
  }
}
