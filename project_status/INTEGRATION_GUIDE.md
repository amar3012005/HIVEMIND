# HIVE-MIND - Integration Guide for Customers

## How to Integrate HIVE-MIND

---

## Option 1: REST API Integration (Recommended)

### Step 1: Get Your API Key
1. Sign up at https://api.hivemind.io
2. Navigate to Settings → API Keys
3. Copy your API key

### Step 2: Store a Memory
```bash
curl -X POST https://api.hivemind.io/api/memories \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "I prefer using Rust for backend services",
    "tags": ["language", "preference"],
    "project": "MyProject",
    "user_id": "user-123"
  }'
```

### Step 3: Recall Context Before AI Inference
```bash
curl -X POST https://api.hivemind.io/api/recall \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query_context": "What language should I use for this new service?",
    "user_id": "user-123",
    "max_memories": 5
  }'
```

**Response:**
```json
{
  "memories": [
    {
      "id": "abc-123",
      "content": "I prefer using Rust for backend services",
      "tags": ["language", "preference"],
      "project": "MyProject",
      "score": 0.92
    }
  ],
  "injectionText": "<relevant-memories>\nI prefer using Rust for backend services\n</relevant-memories>"
}
```

### Step 4: Inject into Your AI Prompt
```javascript
const recallResponse = await fetch('https://api.hivemind.io/api/recall', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer YOUR_API_KEY' },
  body: JSON.stringify({ query_context: 'What language should I use?' })
});

const { injectionText } = await recallResponse.json();

// Inject into your AI prompt
const prompt = `${injectionText}\n\nUser question: What language should I use?`;
const aiResponse = await callAI(prompt);
```

### Step 5: Auto-Capture on Session End
```bash
curl -X POST https://api.hivemind.io/api/session/end \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "User discussed project architecture and tech stack",
    "user_id": "user-123"
  }'
```

---

## Option 2: ChatGPT Custom GPT

### Step 1: Create Custom GPT
1. Go to https://chatgpt.com/gpts/create
2. Configure basic settings

### Step 2: Add Actions
1. Click "Actions" in the builder
2. Paste your API endpoint URL
3. Use the provided OpenAPI spec from `/integrations/chatgpt/openapi.yaml`

### Step 3: Configure Instructions
Add to GPT instructions:
```
Before responding to any query, check HIVE-MIND for relevant memories using the search_memories action.
Always reference past conversations when available.
```

---

## Option 3: Claude Actions

### Step 1: Configure Webhook
1. In Claude settings, add a new Action
2. Set webhook URL to your HIVE-MIND endpoint
3. Configure authentication (API key or OAuth)

### Step 2: System Prompt Integration
Add to Claude system prompt:
```
You have access to HIVE-MIND memory system. Before responding:
1. Call /api/recall with the user's query context
2. Use the returned memories to inform your response
3. Format memories in <relevant-memories> XML tags
```

---

## Option 4: MCP Protocol (Cursor IDE, Claude Desktop)

### Step 1: Install MCP Client
- Cursor IDE: Settings → MCP Servers → Add New
- Claude Desktop: `claude_mcp.json` configuration

### Step 2: Configure MCP Server
```json
{
  "mcpServers": {
    "hivemind": {
      "command": "node",
      "args": ["/path/to/mcp-server/server.js"],
      "env": {
        "GROQ_API_KEY": "your-key",
        "DATABASE_URL": "postgres://..."
      }
    }
  }
}
```

### Step 3: Use MCP Tools
Available tools:
- `save_memory` - Store a new memory
- `recall` - Get relevant memories
- `search_memories` - Search with keywords
- `traverse_graph` - Explore relationships

---

## Integration Checklist

- [ ] Get API key from HIVE-MIND
- [ ] Configure authentication (Bearer token)
- [ ] Set up memory storage endpoint
- [ ] Implement recall before AI inference
- [ ] Inject `<relevant-memories>` into prompts
- [ ] Set up session end hooks for auto-capture
- [ ] Test cross-platform handoff
- [ ] Monitor recall latency (<300ms)

---

## Common Patterns

### Pattern 1: Context-Aware Chat
```javascript
async function chatWithMemory(userMessage) {
  // 1. Recall relevant memories
  const recall = await hivemind.recall({
    query_context: userMessage,
    max_memories: 5
  });
  
  // 2. Inject into prompt
  const prompt = `${recall.injectionText}\n\nUser: ${userMessage}`;
  
  // 3. Call AI
  const response = await ai.generate(prompt);
  
  // 4. Auto-capture on session end
  await hivemind.sessionEnd({
    content: `User asked: ${userMessage}\nAI responded: ${response}`
  });
  
  return response;
}
```

### Pattern 2: Multi-Platform Sync
```javascript
// Platform A (ChatGPT)
await hivemind.store({
  content: "I'm building a Rust backend service",
  tags: ["project", "rust"],
  project: "MyService"
});

// Platform B (Claude) - context automatically available
const memories = await hivemind.recall({
  query_context: "What language am I using?"
});
// Returns: "I'm building a Rust backend service"
```

---

## Troubleshooting

### Issue: "API key invalid"
**Solution:** Check your API key format and ensure it's not expired

### Issue: "Recall returns empty"
**Solution:** 
- Check that memories were stored with correct `user_id`
- Verify query context matches stored memories
- Adjust `max_memories` parameter

### Issue: "Latency too high"
**Solution:**
- Enable Redis caching
- Use Groq LLM for faster inference
- Reduce `max_memories` parameter

---

## Support

- Documentation: https://docs.hivemind.io
- Discord: https://discord.gg/hivemind
- Email: support@hivemind.io
