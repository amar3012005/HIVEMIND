# HIVE-MIND - Groq API Configuration

**Date:** 2026-03-09

🔴 **SECURITY NOTICE:** Previous API key was compromised and rotated.
See `project_status/KEY_ROTATION_RECORD.md` for rotation instructions.

---

## 🚀 Quick Start

### Set Environment Variable
```bash
# Generate new key at https://console.groq.com/
export GROQ_API_KEY="your-new-groq-api-key-here"
```

### Test API Connection
```bash
curl -X POST https://api.groq.com/openai/v1/chat/completions \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama-3-3-70b-versatile",
    "messages": [{"role": "user", "content": "Hello"}]
  }' | jq .
```

### Test Embedding
```bash
curl -X POST https://api.groq.com/openai/v1/embeddings \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mistral-embed",
    "input": "Test embedding"
  }' | jq .
```

---

## 📋 Available Models

| Model | Purpose | Cost (per 1M tokens) |
|-------|---------|---------------------|
| `mistral-embed` | Vector embeddings | ~$0.04 |
| `llama-3-3-70b-versatile` | Inference | ~$0.59 |
| `llama-3-1-70b` | General purpose | ~$0.59 |
| `gpt-oss-20b` | Reasoning | ~$0.59 |

---

## 🎯 Use Cases

### 1. Contextual Situationalization
**Prompt Template:**
```
You are a situationalizer. Convert raw text into context-rich memories.

Input: {raw_text}
Source: {source_context}

Output: A one-sentence context that includes the source information.
Format: "This is from [SOURCE]; [ORIGINAL_TEXT]"
```

### 2. Code Understanding
**Prompt Template:**
```
Analyze this code and extract:
1. The main purpose
2. Key variables/functions
3. Dependencies
4. Usage context

Code:
{code_chunk}
```

### 3. Scope Chain Generation
**Prompt Template:**
```
For this code, identify the scope chain:
- File name
- Class (if any)
- Method (if any)
- Logic block

Code:
{code_chunk}
```

---

## 📊 Cost Optimization

### Caching Strategy
- Cache embeddings for identical inputs
- Cache situationalization results
- Use Redis for in-memory caching

### Batching
- Batch embeddings (up to 100 texts)
- Batch situationalization (up to 50 texts)

### Model Selection
- Use `mistral-embed` for embeddings (cheapest)
- Use `llama-3-3-70b-versatile` for situationalization
- Use `gpt-oss-20b` only for reasoning tasks

---

## 🔧 Integration Points

### 1. Embedding Service
**File:** `src/embeddings/groq.js`
```javascript
const groq = new GroqProvider({
  apiKey: process.env.GROQ_API_KEY,
  model: process.env.GROQ_EMBEDDING_MODEL || 'mistral-embed'
});
```

### 2. Situationalizer Service
**File:** `src/situationalizer.js`
```javascript
const groq = new GroqProvider({
  apiKey: process.env.GROQ_API_KEY,
  model: process.env.GROQ_INFERENCE_MODEL || 'llama-3-3-70b-versatile'
});
```

### 3. MCP Server
**File:** `mcp-server/server.js`
```javascript
const groq = new GroqProvider({
  apiKey: process.env.GROQ_API_KEY,
  model: process.env.GROQ_INFERENCE_MODEL
});
```

---

## 🚨 API Limits

| Limit | Value |
|-------|-------|
| Requests/minute | 300 |
| Tokens/minute | 14,400 |
| Max request size | 128KB |

---

## 📞 Support

- **API Docs:** https://console.groq.com/docs
- **Status:** https://status.groq.com/
- **Discord:** https://discord.gg/groq

---

*Last updated: 2026-03-09*
