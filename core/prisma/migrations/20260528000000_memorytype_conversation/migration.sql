-- Add 'conversation' value to MemoryType enum.
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block, must be
-- standalone. IF NOT EXISTS makes it idempotent for re-runs.

ALTER TYPE hivemind."MemoryType" ADD VALUE IF NOT EXISTS 'conversation';
