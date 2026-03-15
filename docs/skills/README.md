# HIVE-MIND Skill System Documentation

## Overview

The HIVE-MIND Skill System is a production-grade, enterprise-ready plugin architecture that enables:

- **User-installable skills** via CLI and Web UI
- **Secure sandboxed execution** with permission controls
- **Hot-reload** for development
- **Marketplace distribution** with version management
- **Enterprise governance** with audit trails

## Quick Start

### Install a Skill

```bash
# Search for skills
hivemind-skills search analytics

# Install a skill
hivemind-skills install memory-insights

# List installed skills
hivemind-skills list

# Activate a skill
hivemind-skills activate memory-insights

# Execute a capability
hivemind-skills exec memory-insights generateMemoryReport
```

### Create a New Skill

```bash
# Create from template
hivemind-skills create my-skill --template analysis

# Validate
hivemind-skills validate ./skills/custom/my-skill

# Test locally
hivemind-skills activate ./skills/custom/my-skill
```

## Architecture

### Core Components

```
skills/
├── core/                    # Core skill system
│   ├── skill-registry.js    # Skill registration & lifecycle
│   ├── skill-loader.js      # Dynamic loading & hot-reload
│   ├── sandbox.js           # Secure execution environment
│   └── base-skill.js        # Base class for all skills
├── builtin/                 # Built-in skills
│   ├── memory-insights/
│   ├── temporal-queries/
│   └── batch-processor/
├── registry/                # User-installed skills
└── examples/                # Example skills

cli/
└── skills.js                # CLI commands

sdk/
└── skill/
    └── index.js             # Skill development SDK

marketplace/
└── skills/
    └── catalog.json         # Marketplace catalog
```

### Skill Lifecycle

```
registered → activated → running → deactivated → destroyed
     ↑_________________________________________|
```

## Skill Manifest

Each skill requires a `skill.json` manifest:

```json
{
  "name": "my-skill",
  "version": "1.0.0",
  "description": "What this skill does",
  "type": "analysis",
  "author": "Your Name",
  "license": "MIT",
  "entry": "index.js",
  "capabilities": ["analyze", "report"],
  "permissions": ["memory:read", "recall:quick"],
  "apis": ["memory", "recall"],
  "config": {
    "defaultLimit": 10
  },
  "tags": ["analysis", "reporting"]
}
```

### Manifest Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Skill identifier |
| `version` | Yes | Semantic version |
| `description` | Yes | Short description |
| `type` | Yes | Skill category |
| `author` | No | Author name |
| `license` | No | License identifier |
| `entry` | Yes | Entry point file |
| `capabilities` | Yes | List of provided methods |
| `permissions` | Yes | Required permissions |
| `apis` | Yes | APIs used |
| `config` | No | Default configuration |
| `tags` | No | Search tags |

### Skill Types

- `utility` - General utility functions
- `analysis` - Data analysis and insights
- `ingestion` - Data import and processing
- `query` - Advanced querying
- `integration` - External service integration
- `visualization` - Charts and visualizations

### Permissions

| Permission | Description |
|------------|-------------|
| `memory:read` | Read from memory store |
| `memory:write` | Write to memory store |
| `graph:read` | Read graph relationships |
| `graph:write` | Modify graph |
| `recall:quick` | Use quick search |
| `recall:panorama` | Use panorama search |
| `recall:insight` | Use insight search |
| `store:read` | Read from skill store |
| `store:write` | Write to skill store |
| `*` | All permissions (dangerous) |

## Skill Development

### Basic Skill Structure

```javascript
import { BaseSkill } from '../../core/base-skill.js';

export default class MySkill extends BaseSkill {
  constructor(options) {
    super(options);
  }

  async initialize() {
    this.info('Initializing MySkill');
    await super.initialize();
  }

  async myCapability(args = {}) {
    this.info('Executing myCapability', args);

    // Use memory API
    const memories = await this.callSkill('memory', 'recall', {
      query: args.query
    });

    // Process and return
    return {
      success: true,
      data: memories
    };
  }
}
```

### Using the SDK

```javascript
import { createSkillFromTemplate } from '@hivemind/sdk/skill';

// Create from template
await createSkillFromTemplate('my-skill', {
  template: 'analysis',
  author: 'Your Name',
  description: 'My custom skill'
});

// Validate
import { validateSkillManifest } from '@hivemind/sdk/skill';
await validateSkillManifest('./my-skill');

// Package for distribution
import { packageSkill } from '@hivemind/sdk/skill';
await packageSkill('./my-skill', './dist/my-skill.json');
```

### Skill APIs

#### Memory API

```javascript
// Store memory
const id = await hivemind.memory.store(content, metadata);

// Recall memories
const results = await hivemind.memory.recall(query, options);

// Update memory
await hivemind.memory.update(id, updates);

// Delete memory
await hivemind.memory.forget(id);

// Traverse graph
const related = await hivemind.memory.traverse(startId, { depth: 3 });
```

#### Graph API

```javascript
// Create node
const node = await hivemind.graph.createNode(data);

// Create edge
await hivemind.graph.createEdge(from, to, type, metadata);

// Search
const results = await hivemind.graph.search(query);

// Get node
const node = await hivemind.graph.getNode(id);

// Get edges
const edges = await hivemind.graph.getEdges(id, direction);
```

#### Recall API

```javascript
// Quick search
const quick = await hivemind.recall.quick(query);

// Panorama (including expired)
const panorama = await hivemind.recall.panorama(query);

// Insight (deep analysis)
const insight = await hivemind.recall.insight(query);

// Interview entity
const entity = await hivemind.recall.interview(entityId);
```

#### Store API

```javascript
// Key-value storage for skills
await hivemind.store.set('key', value, ttl);
const value = await hivemind.store.get('key');
await hivemind.store.delete('key');
const keys = await hivemind.store.list('*');
```

## Security

### Sandbox Execution

Skills run in a sandboxed environment with:

- **Timeout limits** (default: 30s)
- **Memory limits** (default: 128MB)
- **Permission checks** on all API calls
- **No network access** (unless explicitly granted)
- **No filesystem access** (unless explicitly granted)
- **No child processes**

### Permission Model

```javascript
// Manifest declares required permissions
{
  "permissions": [
    "memory:read",     // Can read memories
    "memory:write",    // Can store memories
    "recall:quick"     // Can use quick search
  ]
}
```

### Logging

All skill activity is logged:

```javascript
// Inside skill
this.info('Processing', { itemCount: 10 });
this.warn('Rate limit approaching');
this.error('Failed', error);
```

## Enterprise Features

### Audit Trail

All skill executions are audited:

```javascript
{
  timestamp: "2026-03-15T10:00:00Z",
  skillId: "memory-insights",
  capability: "generateMemoryReport",
  userId: "user_123",
  orgId: "org_456",
  args: { ... },
  result: "success"
}
```

### Governance

- Skill approval workflows
- Version pinning
- Permission review
- Usage quotas
- Activity monitoring

### Multi-Tenancy

Skills respect tenant boundaries:

```javascript
// Automatically scoped to user's org
const memories = await hivemind.memory.recall(query, {
  filter: { orgId: context.orgId }
});
```

## Best Practices

### 1. Capability Design

- Keep capabilities focused and single-purpose
- Accept options objects for extensibility
- Return consistent result shapes

```javascript
// Good
async analyzeSentiment(args = {}) {
  const { text, language = 'en', model = 'default' } = args;
  // ...
  return {
    success: true,
    sentiment: 'positive',
    score: 0.85,
    confidence: 0.92
  };
}
```

### 2. Error Handling

```javascript
async myCapability(args) {
  try {
    // ... work
  } catch (err) {
    this.error('Capability failed', err);
    throw new Error(`MyCapability failed: ${err.message}`);
  }
}
```

### 3. Configuration

```javascript
// Use config with defaults
const limit = this.getConfig('defaultLimit', 10);
const timeout = this.getConfig('timeout', 5000);
```

### 4. Logging

```javascript
// Structured logging
this.info('Processing batch', {
  batchSize: items.length,
  estimatedTime: '2m'
});
```

## CLI Reference

### Commands

| Command | Description |
|---------|-------------|
| `list` | List installed skills |
| `search <query>` | Search marketplace |
| `install <id>` | Install skill |
| `uninstall <id>` | Uninstall skill |
| `activate <id>` | Activate skill |
| `deactivate <id>` | Deactivate skill |
| `info <id>` | Show skill info |
| `exec <id> <capability>` | Execute capability |
| `create <name>` | Create new skill |
| `validate <path>` | Validate skill |
| `health` | Check skill health |

### Options

```bash
# Output as JSON
hivemind-skills list --json

# Include built-in skills
hivemind-skills list --all

# Pass arguments
hivemind-skills exec my-skill myCapability --args '{"key":"value"}'
```

## Marketplace

### Publishing

1. Validate your skill
2. Package with SDK
3. Submit to marketplace
4. Await approval
5. Published!

### Categories

- Analysis
- Ingestion
- Integration
- Query
- Visualization
- Utility

### Featured Skills

Skills marked as `featured: true` appear on the marketplace homepage.

## Troubleshooting

### Skill won't load

```bash
# Validate manifest
hivemind-skills validate ./my-skill

# Check permissions
hivemind-skills info my-skill
```

### Capability fails

```bash
# Check logs
hivemind-skills exec my-skill myCapability 2>&1

# Test in isolation
hivemind-skills deactivate my-skill
hivemind-skills activate my-skill
```

### Hot reload not working

```bash
# Restart skill
hivemind-skills deactivate my-skill
hivemind-skills activate my-skill
```

## Examples

See `skills/examples/` for complete examples:

- `hello-world/` - Basic skill
- `data-processor/` - Batch processing
- `slack-bot/` - External integration

## API Reference

See [API Documentation](./api.md) for complete API reference.

## Contributing

See [Contributing Guide](./contributing.md) for how to contribute skills.

## License

EUPL-1.2 for built-in skills. Third-party skills may have their own licenses.
