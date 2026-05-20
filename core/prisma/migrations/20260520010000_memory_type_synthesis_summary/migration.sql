-- Add synthesis + summary memory types for the cognition loop.
ALTER TYPE hivemind."MemoryType" ADD VALUE IF NOT EXISTS 'synthesis';
ALTER TYPE hivemind."MemoryType" ADD VALUE IF NOT EXISTS 'summary';
