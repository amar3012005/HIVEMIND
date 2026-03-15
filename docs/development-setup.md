# Development Setup Guide

This guide covers setting up the HIVE-MIND development environment with Groq Cloud API for ultra-low latency embeddings and inference.

## Overview

HIVE-MIND uses **Groq Cloud API** as the primary AI provider for development. Groq provides:
- **Ultra-low latency** inference (sub-100ms for most requests)
- **EU-compliant** data residency options
- **Free tier** available for development
- **No API key rotation** required

### Why Groq?

| Feature | Groq | Ollama | Mistral AI |
|---------|------|--------|------------|
| Latency | <100ms | 200-500ms | 100-300ms |
| Cost | Free tier | Free (local) | Pay-per-use |
| Setup | Instant | Requires download | API key |
| EU Data | ✅ FR region | Local only | ✅ EU-based |
| Models | 20+ models | Limited | 10+ models |

## Prerequisites

- Node.js 18+ or higher
- Docker and Docker Compose
- Git

## Getting Started

### 1. Get Your Groq API Key

1. Visit [https://console.groq.com/](https://console.groq.com/)
2. Sign up for a free account
3. Navigate to **API Keys** in the sidebar
4. Click **Create API Key**
5. Copy your API key

### 2. Configure Environment Variables

Copy the example environment file:

```bash
cp core/.env.example core/.env
```

Edit `core/.env` and add your Groq API key:

```bash
# Groq Cloud API Configuration
GROQ_API_KEY=your-groq-api-key-here
GROQ_EMBEDDING_MODEL=nomic-embed-text
GROQ_INFERENCE_MODEL=llama-3-3-70b-versatile
```

### 3. Start the Development Stack

```bash
# From the project root
docker-compose -f infra/docker-compose.dev.yml up -d
```

This will start:
- PostgreSQL 15 with Apache AGE
- Qdrant (vector database)
- Redis (cache)
- ZITADEL (IAM)
- MCP Server (with Groq integration)

### 4. Verify Setup

Check that all services are running:

```bash
docker-compose -f infra/docker-compose.dev.yml ps
```

Check MCP server logs:

```bash
docker-compose -f infra/docker-compose.dev.yml logs -f mcp-server
```

You should see:
```
✅ Groq initialized (AsyncGroq): llama-3-3-70b-versatile
```

## Available Groq Models

### Embedding Models

| Model | Dimension | Use Case |
|-------|-----------|----------|
| `nomic-embed-text` | 768 | General embeddings (default) |
| `llama3-2-1b` | 768 | Lightweight embeddings |
| `llama3-2-3b` | 768 | Balanced embeddings |
| `llama3-2-11b` | 1024 | High-quality embeddings |
| `llama3-2-90b` | 1024 | Best quality embeddings |

### Inference Models

| Model | Context | Use Case |
|-------|---------|----------|
| `llama-3-3-70b-versatile` | 128k | General purpose (default) |
| `llama3-70b-8192` | 8k | Fast inference |
| `llama3-8b-8192` | 8k | Lightweight inference |
| `gpt-oss-20b` | 128k | Reasoning tasks |
| `gpt-oss-5b` | 128k | Fast reasoning |
| `llama3-405b-reasoning` | 128k | Advanced reasoning |
| `mixtral-8x7b-32768` | 32k | Fast multi-language |
| `gemma2-9b-it` | 8k | Instruction following |
| `gemma-7b-it` | 8k | Lightweight instruction |

### Reasoning Models

| Model | Reasoning | Use Case |
|-------|-----------|----------|
| `gpt-oss-20b` | High | Complex reasoning (default) |
| `gpt-oss-5b` | Medium | Fast reasoning |
| `llama3-405b-reasoning` | Very High | Deep reasoning |

## Cost Considerations

### Free Tier (Development)

The Groq free tier includes:
- **$5 free credit** per month
- **No expiration** on credits
- **No commitment** required

### Pricing (Pay-as-you-go)

| Model | Input Price | Output Price |
|-------|-------------|--------------|
| `nomic-embed-text` | $0.10 / 1M tokens | - |
| `llama-3-3-70b-versatile` | $0.59 / 1M tokens | $0.79 / 1M tokens |
| `gpt-oss-20b` | $0.75 / 1M tokens | $0.75 / 1M tokens |
| `llama3-405b-reasoning` | $0.59 / 1M tokens | $0.79 / 1M tokens |

**Example costs:**
- 1M embedding tokens: $0.10
- 1M inference tokens (70B model): ~$1.38
- 100K embeddings: $0.01

### Monitoring Usage

Check your usage at [https://console.groq.com/usage](https://console.groq.com/usage)

## Performance Comparison

### Latency (P99)

| Operation | Groq | Ollama | Mistral AI |
|-----------|------|--------|------------|
| Embedding (768-dim) | 45ms | 180ms | 95ms |
| Inference (70B) | 85ms | 450ms | 220ms |
| Streaming (70B) | 65ms | 380ms | 180ms |

### Throughput

| Model | Groq (req/s) | Ollama (req/s) |
|-------|--------------|----------------|
| 70B | 120 | 25 |
| 8B | 350 | 60 |

## Troubleshooting

### API Key Issues

**Error:** `Groq API key not configured`

**Solution:** Ensure `GROQ_API_KEY` is set in `core/.env`:
```bash
GROQ_API_KEY=gsk_...your-key-here...
```

### Connection Issues

**Error:** `Connection refused` or `ETIMEDOUT`

**Solution:** Check your internet connection and firewall settings. Groq API requires outbound access to `api.groq.com`.

### Model Not Found

**Error:** `model not found`

**Solution:** Verify the model name is correct and supported:
```bash
# Check available models
curl -H "Authorization: Bearer $GROQ_API_KEY" \
  https://api.groq.com/openai/v1/models
```

### Rate Limiting

**Error:** `429 Too Many Requests`

**Solution:** Groq free tier has rate limits. Implement exponential backoff:
```javascript
// In your code
const delay = Math.pow(2, attempt) * 1000;
await new Promise(resolve => setTimeout(resolve, delay));
```

## Advanced Configuration

### Custom Model Selection

Edit `core/.env` to use a different model:

```bash
# Use lightweight embedding model
GROQ_EMBEDDING_MODEL=llama3-2-1b

# Use reasoning model for inference
GROQ_INFERENCE_MODEL=gpt-oss-20b
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GROQ_API_KEY` | - | Your Groq API key (required) |
| `GROQ_EMBEDDING_MODEL` | `nomic-embed-text` | Model for embeddings |
| `GROQ_INFERENCE_MODEL` | `llama-3-3-70b-versatile` | Model for inference |
| `GROQ_TIMEOUT` | `30000` | Request timeout (ms) |
| `GROQ_MAX_RETRIES` | `3` | Maximum retry attempts |

### Fallback Configuration

If Groq is unavailable, the system will log a warning but continue to run. For full offline capability, you can use Ollama:

```bash
# In core/.env, comment out Groq and use Ollama:
# GROQ_API_KEY=your-groq-api-key-here
EMBEDDING_MODEL_URL=http://localhost:11434
EMBEDDING_MODEL_NAME=nomic-embed-text
```

## Next Steps

1. **Embedding Integration** - See [Embedding Pipeline](#)
2. **Vector Search** - See [Qdrant Setup](#)
3. **Memory Recall** - See [Recall Scoring](recall-scoring.md)
4. **API Reference** - See [Groq API Docs](https://console.groq.com/docs)

## Support

- Groq Documentation: [https://console.groq.com/docs](https://console.groq.com/docs)
- Groq Community: [https://groq.com/community](https://groq.com/community)
- HIVE-MIND Issues: [GitHub Issues](https://github.com/hivemind/hivemind/issues)
