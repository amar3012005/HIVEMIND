const DEFAULT_TIMEZONE = 'Europe/Berlin';
const MORNING_HOUR = 9;

function dateParts(date, timeZone) {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second) };
}

export function safeLifecycleTimezone(value) {
  const timeZone = String(value || '').trim() || DEFAULT_TIMEZONE;
  try { new Intl.DateTimeFormat('en-CA', { timeZone }).format(); return timeZone; } catch { return DEFAULT_TIMEZONE; }
}

function offsetAt(instant, timeZone) {
  const p = dateParts(instant, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant.getTime();
}

/** Convert an intended local wall-clock timestamp to UTC, including DST shifts. */
function zonedInstant({ year, month, day, hour }, timeZone) {
  const wallClock = Date.UTC(year, month - 1, day, hour, 0, 0);
  let instant = new Date(wallClock);
  for (let attempt = 0; attempt < 3; attempt += 1) instant = new Date(wallClock - offsetAt(instant, timeZone));
  return instant;
}

/**
 * Day lifecycle episodes deliberately mean the following calendar morning,
 * never an elapsed number of hours. This avoids a late Day-0 delivery causing
 * a late Day-1 email and remains correct over daylight-saving transitions.
 */
export function nextLocalLifecycleMorning(after, { timeZone, hour = MORNING_HOUR } = {}) {
  const zone = safeLifecycleTimezone(timeZone);
  const base = after instanceof Date ? after : new Date(after);
  const valid = Number.isFinite(base.getTime()) ? base : new Date();
  const local = dateParts(valid, zone);
  const tomorrow = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  return zonedInstant({ year: tomorrow.getUTCFullYear(), month: tomorrow.getUTCMonth() + 1, day: tomorrow.getUTCDate(), hour: Math.max(0, Math.min(23, Number(hour) || MORNING_HOUR)) }, zone);
}

export const LIFECYCLE_DEFAULT_TIMEZONE = DEFAULT_TIMEZONE;
export const LIFECYCLE_MORNING_HOUR = MORNING_HOUR;
