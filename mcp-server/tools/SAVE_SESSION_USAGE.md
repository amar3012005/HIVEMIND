# save_session Tool - Usage Documentation

## Overview

The `save_session` MCP tool automatically saves complete chat sessions as structured memories with intelligent summarization and decision/lesson extraction. It captures the full context of conversations across all AI platforms (ChatGPT, Claude, Perplexity, Gemini, etc.) and stores them in HIVE-MIND's cross-platform memory system.

## Features

- **Automatic Summarization**: Uses Groq API (Llama 3.3 70B) to generate concise session summaries
- **Decision Extraction**: Automatically identifies and stores technology choices, preferences, and architectural decisions
- **Lesson Capture**: Extracts insights and learnings from conversations
- **Cross-Platform Sync**: Saved sessions sync automatically across all connected platforms via Meta-MCP Bridge
- **Structured Storage**: Sessions stored with full metadata including platform, timestamps, and message count
- **Token Management**: Calculates token counts for context window optimization

## Installation

### Prerequisites

1. **HIVE-MIND MCP Server** running (see [mcp-server/README.md](../mcp-server/README.md))
2. **Groq API Key** (optional, for auto-summarization)
3. **HIVE-MIND API** access

### Environment Variables

```bash
# Required
HIVEMIND_API_URL=http://localhost:3000
HIVEMIND_API_KEY=your-api-key
CURRENT_USER_ID=your-user-uuid

# Optional (for auto-summarization)
GROQ_API_KEY=your-groq-api-key
GROQ_INFERENCE_MODEL=llama-3.3-70b-versatile
```

## Usage

### Basic Usage

Save a session with minimal parameters:

```javascript
save_session({
  platform: 'claude',
  messages: [
    { role: 'user', content: 'What should I use for backend?' },
    { role: 'assistant', content: 'TypeScript is a great choice...' }
  ],
  startTime: '2026-03-12T10:00:00Z',
  endTime: '2026-03-12T10:30:00Z'
})
```

### With Auto-Summarization

Enable automatic summarization and decision extraction:

```javascript
save_session({
  platform: 'chatgpt',
  messages: [...],
  startTime: '2026-03-12T11:00:00Z',
  endTime: '2026-03-12T11:45:00Z',
  autoSummarize: true,        // Generate summary using Groq API
  extractDecisions: true,     // Extract decisions and lessons
  tags: ['backend', 'architecture'],
  importanceScore: 0.8
})
```

### With Custom Summary

Provide your own summary (skip auto-summarization):

```javascript
save_session({
  platform: 'claude',
  messages: [...],
  startTime: '2026-03-12T10:00:00Z',
  endTime: '2026-03-12T10:30:00Z',
  summary: 'Discussion about backend technology stack. Decided to use TypeScript with Node.js and PostgreSQL.',
  autoSummarize: false,
  tags: ['typescript', 'nodejs', 'postgresql']
})
```

### From MCP Client (Claude Desktop / Cursor)

```
Save this session:
- Platform: claude
- Messages: [paste conversation or reference current session]
- Start time: 2026-03-12T10:00:00Z
- End time: 2026-03-12T10:30:00Z
- Auto-summarize: true
- Extract decisions: true
```

## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `platform` | string | ✅ Yes | - | Platform where session occurred: `chatgpt`, `claude`, `perplexity`, `gemini`, `mcp`, `other` |
| `messages` | array | ✅ Yes | - | Array of conversation messages (min 1 message) |
| `startTime` | string | ✅ Yes | - | Session start time (ISO 8601 format) |
| `endTime` | string | ✅ Yes | - | Session end time (ISO 8601 format) |
| `sessionId` | string | ❌ No | `uuid` | External session ID from platform |
| `userId` | string | ❌ No | env `CURRENT_USER_ID` | User UUID (defaults to environment) |
| `summary` | string | ❌ No | auto-generated | Pre-computed session summary (1-10000 chars) |
| `autoSummarize` | boolean | ❌ No | `true` | Generate summary using Groq API |
| `extractDecisions` | boolean | ❌ No | `true` | Extract decisions and lessons |
| `tags` | array | ❌ No | `[]` | Tags for categorization |
| `importanceScore` | number | ❌ No | `0.5` | Importance score 0-1 |

### Message Object Structure

```javascript
{
  role: 'user' | 'assistant' | 'system',
  content: string,
  timestamp?: string (ISO 8601)
}
```

## Response

### Success Response

```json
{
  "content": [
    {
      "type": "text",
      "text": "✅ **Session Saved Successfully!**\n\n**Memory ID:** `abc123...`\n**Platform:** claude\n**Duration:** 30m\n**Time:** 3/12/2026, 10:00:00 AM - 3/12/2026, 10:30:00 AM\n\n### Summary\nDiscussion about backend technology stack...\n\n**Decisions Captured:** 2\n**Lessons Captured:** 1\n\n_Session context will sync across all connected platforms via Meta-MCP Bridge._"
    }
  ],
  "metadata": {
    "memoryId": "abc123...",
    "decisionsCount": 2,
    "lessonsCount": 1,
    "autoSummarized": true
  }
}
```

### Error Responses

**Validation Error (400):**
```json
{
  "error": "VALIDATION_ERROR",
  "message": "Invalid request body",
  "details": [
    {
      "path": ["platform"],
      "message": "Invalid enum value"
    }
  ]
}
```

**API Error (500):**
```json
{
  "error": "INTERNAL_ERROR",
  "message": "Failed to save session"
}
```

## Examples

### Example 1: Save Architecture Discussion

```javascript
save_session({
  platform: 'claude',
  messages: [
    {
      role: 'user',
      content: 'I\'m designing a microservices architecture. Should I use REST or GraphQL?',
      timestamp: '2026-03-12T14:00:00Z'
    },
    {
      role: 'assistant',
      content: 'Both have their strengths. REST is simpler and more widely adopted. GraphQL gives you more flexibility...',
      timestamp: '2026-03-12T14:00:05Z'
    },
    {
      role: 'user',
      content: 'Let\'s go with REST for now. We can add GraphQL later if needed.',
      timestamp: '2026-03-12T14:05:00Z'
    }
  ],
  startTime: '2026-03-12T14:00:00Z',
  endTime: '2026-03-12T14:05:00Z',
  autoSummarize: true,
  extractDecisions: true,
  tags: ['architecture', 'microservices', 'api-design'],
  importanceScore: 0.9
})
```

**Extracted Decision:**
- Title: "API Architecture Choice"
- Content: "Use REST for microservices architecture, with option to add GraphQL later"
- Confidence: 0.95

### Example 2: Save Debugging Session

```javascript
save_session({
  platform: 'chatgpt',
  messages: [...],
  startTime: '2026-03-12T09:00:00Z',
  endTime: '2026-03-12T09:45:00Z',
  summary: 'Debugged PostgreSQL connection pool exhaustion issue. Root cause was unclosed connections in error paths. Solution: implemented proper connection cleanup with try-finally blocks.',
  autoSummarize: false,
  tags: ['debugging', 'postgresql', 'connections'],
  importanceScore: 0.85
})
```

### Example 3: Save Planning Session

```javascript
save_session({
  platform: 'perplexity',
  messages: [...],
  startTime: '2026-03-12T16:00:00Z',
  endTime: '2026-03-12T17:00:00Z',
  autoSummarize: true,
  extractDecisions: true,
  tags: ['planning', 'roadmap', 'q2-2026'],
  importanceScore: 0.7
})
```

## Integration Examples

### Claude Desktop MCP Configuration

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hivemind": {
      "command": "node",
      "args": ["/path/to/HIVE-MIND/mcp-server/server.js"],
      "env": {
        "HIVEMIND_API_URL": "http://localhost:3000",
        "HIVEMIND_API_KEY": "your-api-key",
        "CURRENT_USER_ID": "your-user-id",
        "GROQ_API_KEY": "your-groq-key"
      }
    }
  }
}
```

### Cursor IDE Integration

In Cursor settings, add MCP server:

```json
{
  "mcp": {
    "hivemind": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/server.js"],
      "env": {
        "HIVEMIND_API_URL": "http://localhost:3000",
        "GROQ_API_KEY": "your-groq-key"
      }
    }
  }
}
```

### Programmatic Usage (Node.js)

```javascript
import { handleSaveSession } from '@hivemind/mcp-server/tools/save-session';

// Your API call wrapper
async function apiCall(method, path, body) {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY
    },
    body: JSON.stringify(body)
  });
  return response.json();
}

// Logger
const logger = {
  info: (msg, ctx) => console.log('[INFO]', msg, ctx),
  warn: (msg, ctx) => console.warn('[WARN]', msg, ctx),
  error: (msg, ctx) => console.error('[ERROR]', msg, ctx)
};

// Save session
const result = await handleSaveSession(
  {
    platform: 'claude',
    messages: [...],
    startTime: '2026-03-12T10:00:00Z',
    endTime: '2026-03-12T10:30:00Z',
    autoSummarize: true,
    extractDecisions: true
  },
  'request-uuid',
  apiCall,
  logger
);

console.log('Session saved:', result.metadata.memoryId);
```

## Best Practices

### When to Use save_session

✅ **Use when:**
- Ending a productive conversation you want to preserve
- Making important decisions during a chat
- Completing a debugging or problem-solving session
- Having architectural or design discussions
- Planning sessions with action items
- Learning sessions with key insights

❌ **Don't use for:**
- Casual conversations without substantive content
- Every single message (use `save_memory` for individual facts)
- Sessions shorter than 5 minutes (unless critical)

### Summarization Tips

1. **Enable auto-summarization** for sessions > 10 messages
2. **Provide custom summary** for highly technical sessions
3. **Use tags** for better organization and retrieval
4. **Set importanceScore** based on session criticality:
   - `0.9-1.0`: Critical architectural decisions
   - `0.7-0.9`: Important project decisions
   - `0.5-0.7`: Regular discussions
   - `0.3-0.5`: Casual conversations

### Tag Strategy

Use consistent tagging for better retrieval:

```javascript
tags: [
  'architecture',      // Category
  'backend',          // Domain
  'typescript',       // Technology
  'decision',         // Content type
  'q2-2026'          // Time period
]
```

## Performance

| Metric | Target | Typical |
|--------|--------|---------|
| Input validation | <10ms | 2-5ms |
| Auto-summarization (Groq) | <5s | 2-3s |
| Decision extraction | <5s | 2-3s |
| Memory storage | <500ms | 100-300ms |
| **Total (with summarization)** | <10s | 3-6s |
| **Total (without summarization)** | <1s | 200-500ms |

## Troubleshooting

### "GROQ_API_KEY is not set"

**Problem:** Auto-summarization fails with this error.

**Solution:** Set the environment variable or disable auto-summarization:
```bash
export GROQ_API_KEY=your-key
```
Or:
```javascript
save_session({ ..., autoSummarize: false })
```

### "startTime must be before endTime"

**Problem:** Timestamps are in wrong order.

**Solution:** Ensure `startTime` is before `endTime`:
```javascript
// ❌ Wrong
startTime: '2026-03-12T11:00:00Z',
endTime: '2026-03-12T10:00:00Z'

// ✅ Correct
startTime: '2026-03-12T10:00:00Z',
endTime: '2026-03-12T11:00:00Z'
```

### "Invalid platform"

**Problem:** Platform value not in allowed enum.

**Solution:** Use one of: `chatgpt`, `claude`, `perplexity`, `gemini`, `mcp`, `other`

### Summarization timeout

**Problem:** Groq API times out after 30 seconds.

**Solution:**
1. Check internet connection
2. Verify Groq API key is valid
3. Reduce message count (max 50 for summarization)
4. Disable auto-summarization and provide custom summary

## Testing

Run the test suite:

```bash
cd mcp-server
node --test tests/save-session.test.js
```

Test categories:
- Schema validation tests
- Utility function tests
- Tool handler tests (mock API)
- Summarizer tests (requires Groq API)
- Extractor tests (requires Groq API)
- Integration tests
- Performance tests
- Edge case tests

## API Reference

### Related Tools

| Tool | Description | When to Use |
|------|-------------|-------------|
| `save_memory` | Save individual memory | Single facts, preferences |
| `recall` | Search memories | Find relevant context |
| `list_memories` | List all memories | Browse memory collection |
| `get_context` | Get conversation context | Pre-inference injection |

### Related Modules

- [`connectors/chat/summarizer.js`](../../connectors/chat/summarizer.js) - Session summarization
- [`connectors/chat/extractor.js`](../../connectors/chat/extractor.js) - Decision/lesson extraction
- [`mcp-server/server.js`](../../mcp-server/server.js) - MCP server registration

## Security

- All input validated with Zod schemas
- Timestamps validated (5-minute future window)
- Token counts calculated for context management
- No sensitive data logged
- API keys from environment variables only

## Changelog

### v1.0.0 (2026-03-12)
- Initial implementation
- Auto-summarization with Groq API
- Decision and lesson extraction
- Cross-platform sync via Meta-MCP Bridge
- Full test coverage

---

**Version:** 1.0.0  
**Last Updated:** March 12, 2026  
**Author:** HIVE-MIND Integration Team
