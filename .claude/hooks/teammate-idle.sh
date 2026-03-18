#!/bin/bash
# HIVEMIND - Teammate Idle Hook
# Called when a teammate is about to go idle
# Exit code 2 = keep working, 0 = allow idle

TEAM_NAME="${CLAUDE_TEAM_NAME:-hivemind}"
TASKS_DIR="$HOME/.claude/tasks/$TEAM_NAME"

# Check for pending tasks
PENDING_COUNT=0
if [ -d "$TASKS_DIR" ]; then
    PENDING_COUNT=$(find "$TASKS_DIR" -name "*.json" -exec grep -l '"status": "pending"' {} \; 2>/dev/null | wc -l)
fi

# Check for in-progress tasks
IN_PROGRESS_COUNT=0
if [ -d "$TASKS_DIR" ]; then
    IN_PROGRESS_COUNT=$(find "$TASKS_DIR" -name "*.json" -exec grep -l '"status": "in_progress"' {} \; 2>/dev/null | wc -l)
fi

echo "📋 Task Status: $PENDING_COUNT pending, $IN_PROGRESS_COUNT in progress"

# If there are pending tasks and no in-progress, keep working
if [ "$PENDING_COUNT" -gt 0 ] && [ "$IN_PROGRESS_COUNT" -eq 0 ]; then
    echo "⚠️  There are $PENDING_COUNT pending tasks available. Please claim one to continue work."
    exit 2
fi

# If still in-progress, check if actually done
if [ "$IN_PROGRESS_COUNT" -gt 0 ]; then
    echo "⏳ There are $IN_PROGRESS_COUNT tasks still in progress. Continue working."
    exit 2
fi

echo "✅ No active tasks. Idle approved."
exit 0
