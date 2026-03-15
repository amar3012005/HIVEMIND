# HIVE-MIND - Quick Start

A production-ready replica of Supermemory.ai with sovereign European architecture.

## 🚀 Start in 30 Seconds

```bash
cd /Users/amar/HIVE-MIND/core
npm install
npm start
```

Then open: **http://localhost:3000**

## ✨ What You Get

- **Triple-Operator Memory**: Updates, Extends, Derives relationships
- **Graph Traversal**: Multi-hop memory connections
- **Ebbinghaus Decay**: Smart forgetting curves
- **Auto-Recall**: Pre-inference memory injection
- **Session Hooks**: Auto-capture decisions & lessons

## 📁 Project Structure

```
HIVE-MIND/
├── client.html          # Web UI (dark mode, graph viz)
├── core/
│   ├── src/
│   │   ├── engine.js    # Memory engine (SQLite)
│   │   └── server.js    # HTTP API server
│   └── package.json
├── skills/              # Claude Code skills (6)
├── subagents/           # Claude Code subagents (4)
└── infra/               # Docker Compose for production
```

## 🔌 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/memories` | GET | List all memories |
| `/api/memories` | POST | Store new memory |
| `/api/memories/search` | POST | Search memories |
| `/api/memories/traverse` | POST | Graph traversal |
| `/api/memories/decay` | POST | Check decay status |
| `/api/recall` | POST | Auto-recall for context |
| `/api/session/end` | POST | Session end hook |

## 🧠 Memory Relationships

- **Updates**: Replaces old memory (marks as inactive)
- **Extends**: Adds detail to existing memory
- **Derives**: Infers connection between memories

## 🛠️ Production Deployment

```bash
# Full sovereign EU stack
cd infra
cp .env.example .env
# Edit .env with your credentials
./deploy.sh
```

This deploys:
- PostgreSQL + Apache AGE (graph database)
- Qdrant (vector search)
- ZITADEL (IAM)
- Hetzner/Scaleway/OVHcloud (EU-only)

## 📝 Example Usage

```javascript
// Store memory
fetch('/api/memories', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    content: "We decided to use Qdrant",
    tags: ["architecture", "decision"],
    project: "hivemind"
  })
});

// Search
fetch('/api/memories/search', {
  method: 'POST',
  body: JSON.stringify({ query: "database decision" })
});

// Traverse graph
fetch('/api/memories/traverse', {
  method: 'POST',
  body: JSON.stringify({ start_id: "mem_123", depth: 3 })
});
```

## 🎯 Next Steps

1. **Test locally** - Use the web UI at http://localhost:3000
2. **Add MCP support** - Connect Claude Desktop, Cursor, etc.
3. **Deploy to cloud** - Use the Docker Compose for EU providers

## 🌐 EU Sovereignty

- ✅ Data never leaves EU
- ✅ GDPR native
- ✅ NIS2/DORA ready
- ✅ Hetzner (DE), Scaleway (FR), OVHcloud (FR)
- ✅ LUKS2 encryption
- ✅ No US CLOUD Act exposure
