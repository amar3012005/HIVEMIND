# @hivemind/sdk

Official JavaScript SDK for HIVE-MIND AI Memory Engine

## Installation

```bash
npm install @hivemind/sdk
```

## Quick Start

```javascript
import { HiveMindClient } from '@hivemind/sdk';

const hivemind = new HiveMindClient({
  url: 'https://hivemind.davinciai.eu:8050',
  apiKey: 'your-api-key',
  userId: 'user_123',
  orgId: 'org_456'
});

// Save a memory
await hivemind.save({
  title: 'Docker deployment tips',
  content: 'Always use multi-stage builds...',
  tags: ['docker', 'devops']
});

// Search
const results = await hivemind.search('docker');
console.log(results);
```

## API Reference

### Constructor

```javascript
new HiveMindClient(config)
```

**Config options:**
- `url` (string, required) - HIVE-MIND API URL
- `apiKey` (string, required) - Your API key
- `userId` (string) - Default user ID
- `orgId` (string) - Default organization ID
- `timeout` (number) - Request timeout in ms (default: 30000)
- `retries` (number) - Number of retries (default: 3)

### Methods

#### `save(memory)`
Save a memory to HIVE-MIND.

```javascript
await hivemind.save({
  title: 'Meeting notes',
  content: 'Discussed new features...',
  sourceType: 'text', // 'text', 'code', 'conversation'
  tags: ['work', 'meeting'],
  project: 'my-project',
  metadata: { priority: 'high' }
});
```

#### `saveCode(code)`
Save a code snippet.

```javascript
await hivemind.saveCode({
  content: 'const x = 1;',
  filepath: 'src/index.js',
  language: 'javascript',
  tags: ['javascript', 'snippet']
});
```

#### `saveConversation(conversation)`
Save a conversation.

```javascript
await hivemind.saveConversation({
  title: 'Claude chat about React',
  messages: [
    { role: 'user', content: 'How do I use hooks?' },
    { role: 'assistant', content: 'You can use useState...' }
  ],
  platform: 'claude'
});
```

#### `search(query, options)`
Search memories.

```javascript
const results = await hivemind.search('docker deployment', {
  limit: 10,
  project: 'devops',
  tags: ['docker']
});
```

#### `query(question, options)`
Query with AI (semantic search).

```javascript
const result = await hivemind.query('What do I know about Docker?', {
  limit: 5
});
console.log(result.answer);
```

#### `get(memoryId)`
Get a memory by ID.

```javascript
const memory = await hivemind.get('memory-uuid-123');
```

#### `update(memoryId, updates)`
Update a memory.

```javascript
await hivemind.update('memory-uuid-123', {
  title: 'Updated title',
  tags: ['updated', 'tag']
});
```

#### `delete(memoryId)`
Delete a memory.

```javascript
await hivemind.delete('memory-uuid-123');
```

#### `list(options)`
List all memories with pagination.

```javascript
const { memories, total, page } = await hivemind.list({
  page: 1,
  limit: 20,
  project: 'my-project'
});
```

#### `bulkSave(memories)`
Save multiple memories at once.

```javascript
await hivemind.bulkSave([
  { title: 'Note 1', content: '...' },
  { title: 'Note 2', content: '...' }
]);
```

#### `health()`
Check API health.

```javascript
const status = await hivemind.health();
// { status: 'ok', timestamp: '...', version: '2.0.0' }
```

## Error Handling

```javascript
import { HiveMindClient, HiveMindError } from '@hivemind/sdk';

try {
  await hivemind.save({ title: 'Test', content: '...' });
} catch (error) {
  if (error instanceof HiveMindError) {
    console.error(`HTTP ${error.statusCode}: ${error.message}`);
  } else {
    console.error('Network error:', error.message);
  }
}
```

## Browser Usage

```html
<script type="module">
  import { HiveMindClient } from 'https://unpkg.com/@hivemind/sdk@latest/dist/index.js';

  const hivemind = new HiveMindClient({
    url: 'https://hivemind.davinciai.eu:8050',
    apiKey: 'your-api-key'
  });
</script>
```

## License

MIT
