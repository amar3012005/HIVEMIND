-- Additive only: preserve every existing MemoryType value and row.
ALTER TYPE hivemind."MemoryType" ADD VALUE IF NOT EXISTS 'commitment';
ALTER TYPE hivemind."MemoryType" ADD VALUE IF NOT EXISTS 'policy';
ALTER TYPE hivemind."MemoryType" ADD VALUE IF NOT EXISTS 'procedure';
