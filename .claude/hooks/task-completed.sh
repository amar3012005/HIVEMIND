#!/bin/bash
# HIVEMIND - Task Completed Hook
# Called when a task is being marked complete
# Exit code 2 = block completion, 0 = allow

TASK_ID="$1"
TEAM_NAME="${CLAUDE_TEAM_NAME:-hivemind}"
TASKS_DIR="$HOME/.claude/tasks/$TEAM_NAME"

echo "🔍 Validating task completion: $TASK_ID"

# Find the task file
TASK_FILE=$(find "$TASKS_DIR" -name "*$TASK_ID*" 2>/dev/null | head -1)

if [ -z "$TASK_FILE" ]; then
    echo "❌ Task file not found for: $TASK_ID"
    exit 0  # Allow - file might already be archived
fi

# Check task actually marked as completed
if ! grep -q '"status": "completed"' "$TASK_FILE" 2>/dev/null; then
    echo "❌ Task $TASK_ID not actually marked as completed in file"
    exit 2
fi

# Check if code was modified (look for git changes in last commit)
if git diff --name-only HEAD~1 2>/dev/null | grep -qE "\.(js|ts|mjs)$"; then
    echo "🧪 Code changes detected. Running tests..."

    # Run HIVEMIND core tests
    cd /opt/HIVEMIND/core

    if [ -f "package.json" ]; then
        npm test 2>&1 | tail -20

        if [ ${PIPESTATUS[0]} -ne 0 ]; then
            echo "❌ Tests failed. Task cannot be marked complete until tests pass."
            exit 2
        fi

        echo "✅ All tests passed"
    else
        echo "⚠️  No package.json found, skipping tests"
    fi
fi

# Check for Qdrant vector storage if memory was created
if git diff --name-only HEAD~1 2>/dev/null | grep -qE "(server\.js|memory|qdrant)"; then
    echo "🧠 Memory/Qdrant changes detected. Verifying vector storage..."

    # Quick health check
    QDRANT_URL="https://24826665-41d6-4ea6-b13f-fc42438c4c55.eu-central-1-0.aws.cloud.qdrant.io:6333"
    QDRANT_API_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2Nlc3MiOiJtIn0.fo75c0vRt9MhfhcQB0fP-m-MiU4gCYZD_yv23YNtyJc"

    response=$(curl -s -X GET "$QDRANT_URL/collections/BUNDB%20AGENT" \
        -H "api-key: $QDRANT_API_KEY" 2>/dev/null)

    status=$(echo "$response" | jq -r '.result.status' 2>/dev/null)

    if [ "$status" = "green" ]; then
        echo "✅ Qdrant collection healthy"
    else
        echo "⚠️  Qdrant status: $status (may need attention)"
    fi
fi

echo "✅ Task $TASK_ID completed and validated"
exit 0
