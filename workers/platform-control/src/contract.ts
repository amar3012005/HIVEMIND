export type RegistryEntity =
  | "user"
  | "organization"
  | "membership"
  | "invite"
  | "api_key"
  | "entitlement"
  | "memory_box"
  | "team"
  | "project"
  | "team_member"
  | "project_member"
  | "notification"
  | "organization_profile"
  | "billing_checkout"
  | "plan_catalog";
export type RegistryEvent = {
  event_id: string;
  entity_type: RegistryEntity;
  entity_id: string;
  revision: number;
  operation: "upsert" | "delete";
  payload: Record<string, unknown>;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown) => UUID.test(String(value || ""));
export function validEvent(value: unknown): value is RegistryEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const e = value as Partial<RegistryEvent>;
  return (
    isUuid(e.event_id) &&
    isUuid(e.entity_id) &&
    [
      "user",
      "organization",
      "membership",
      "invite",
      "api_key",
      "entitlement",
      "memory_box",
      "team",
      "project",
      "team_member",
      "project_member",
      "notification",
      "organization_profile",
      "billing_checkout",
      "plan_catalog",
    ].includes(String(e.entity_type)) &&
    Number.isInteger(e.revision) &&
    Number(e.revision) > 0 &&
    ["upsert", "delete"].includes(String(e.operation)) &&
    !!e.payload &&
    typeof e.payload === "object" &&
    !Array.isArray(e.payload)
  );
}
export function normalizedEmail(value: unknown): string | null {
  const email = String(value || "")
    .trim()
    .toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
export function redactedEvent(event: RegistryEvent) {
  return {
    event_id: event.event_id,
    entity_type: event.entity_type,
    entity_id: event.entity_id,
    revision: event.revision,
    operation: event.operation,
  };
}
