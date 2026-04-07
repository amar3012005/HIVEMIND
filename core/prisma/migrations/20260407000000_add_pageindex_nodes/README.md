# Add PageIndexNode Table

This migration adds the optional PageIndex hierarchical memory index.

**Features:**
- Hierarchical tree structure (max 4 levels)
- Memory ID storage (no content duplication)
- Cross-referencing (memory in multiple nodes)
- Auto-evolution support (pruning, growth)

**Safe for production:**
- Table created with IF NOT EXISTS
- Server starts without this table (graceful fallback)
- Backfill script populates existing memories asynchronously
