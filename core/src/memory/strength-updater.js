/**
 * Memory-type behaviour driver (Phase 6 of GRAPH_MEMORY_UPGRADE).
 *
 * Pure functions that compute strength / archive decisions per memory type.
 * Callers (cron job, memory-processor, recall path) apply the returned actions.
 *
 *   fact        Default. Updates flip isLatest (handled elsewhere).
 *   preference  Recall count >= 3 -> bump strength by 0.1 per hit (cap 1.0).
 *   event       After 90d unrecalled -> soft-archive (deletedAt set).
 *   decision    Immutable once superseded. Original kept queryable forever.
 *   goal        Has target_date / event_dates -> flag for review when past.
 *   lesson      Strengthens via recall like preference.
 *   relationship Strengthens via recall, never auto-archives.
 */

const EVENT_DECAY_DAYS = 90;
const PREFERENCE_RECALL_BUMP = 0.1;
const PREFERENCE_BUMP_THRESHOLD = 3;
const STRENGTH_CAP = 1.0;
const STRENGTH_FLOOR = 0.0;

function daysSince(date) {
  if (!date) return Infinity;
  const ts = date instanceof Date ? date.getTime() : Date.parse(date);
  if (!Number.isFinite(ts)) return Infinity;
  return (Date.now() - ts) / (1000 * 60 * 60 * 24);
}

/**
 * Called when a memory is recalled (retrieval hit).
 * Returns { strength, recallCount, lastConfirmedAt } patch object, or null if no change.
 */
export function onRecall(memory) {
  if (!memory) return null;
  const type = memory.memoryType || memory.memory_type || 'fact';
  const currentStrength = Number.isFinite(memory.strength) ? memory.strength : 1.0;
  const currentCount = Number.isInteger(memory.recallCount) ? memory.recallCount : 0;
  const nextCount = currentCount + 1;

  const patch = {
    recallCount: nextCount,
    lastConfirmedAt: new Date(),
  };

  // Strengthening types: preference, lesson, relationship
  if (type === 'preference' || type === 'lesson' || type === 'relationship') {
    if (nextCount >= PREFERENCE_BUMP_THRESHOLD) {
      const next = Math.min(STRENGTH_CAP, currentStrength + PREFERENCE_RECALL_BUMP);
      if (next !== currentStrength) patch.strength = next;
    }
  }

  // Events get a smaller bump and reset their decay clock via lastConfirmedAt
  if (type === 'event' && nextCount >= 2) {
    const next = Math.min(STRENGTH_CAP, currentStrength + 0.05);
    if (next !== currentStrength) patch.strength = next;
  }

  return patch;
}

/**
 * Decay tick — call from nightly cron over all memories for a user.
 * Returns { action: 'archive'|'flag_review'|null, reason, patch? }.
 */
export function decayTick(memory, now = new Date()) {
  if (!memory) return { action: null };
  if (memory.deletedAt) return { action: null };

  const type = memory.memoryType || memory.memory_type || 'fact';
  const lastConfirmed = memory.lastConfirmedAt || memory.last_confirmed_at || memory.updatedAt || memory.createdAt;
  const days = daysSince(lastConfirmed);

  if (type === 'event') {
    if (days >= EVENT_DECAY_DAYS) {
      return {
        action: 'archive',
        reason: `event unrecalled ${Math.floor(days)}d (>= ${EVENT_DECAY_DAYS}d)`,
        patch: { deletedAt: now },
      };
    }
    return { action: null };
  }

  if (type === 'goal') {
    const target = memory.targetDate || memory.target_date || memory.documentDate;
    if (target) {
      const targetTs = target instanceof Date ? target.getTime() : Date.parse(target);
      if (Number.isFinite(targetTs) && targetTs < now.getTime()) {
        // No supersession recorded -> flag review
        if (!memory.supersedesId && !memory.supersedes_id) {
          return {
            action: 'flag_review',
            reason: `goal target_date passed (${new Date(targetTs).toISOString().slice(0, 10)})`,
          };
        }
      }
    }
    return { action: null };
  }

  // facts / preferences / lessons / decisions / relationships: gentle decay if not recalled
  // Decay 0.02/30d, floor 0.1. Never auto-archive non-events.
  if (Number.isFinite(memory.strength) && days > 30) {
    const ticks = Math.floor(days / 30);
    const decayed = Math.max(STRENGTH_FLOOR + 0.1, memory.strength - 0.02 * ticks);
    if (decayed !== memory.strength) {
      return {
        action: 'decay',
        reason: `${type} unrecalled ${Math.floor(days)}d`,
        patch: { strength: decayed },
      };
    }
  }

  return { action: null };
}

export const TUNING = {
  EVENT_DECAY_DAYS,
  PREFERENCE_RECALL_BUMP,
  PREFERENCE_BUMP_THRESHOLD,
  STRENGTH_CAP,
  STRENGTH_FLOOR,
};
