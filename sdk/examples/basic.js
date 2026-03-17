/**
 * HIVE-MIND SDK Examples
 * Run with: node examples.js
 */

import { HiveMindClient } from '../src/index.js';

// Configuration
const config = {
  url: process.env.HIVEMIND_URL || 'https://hivemind.davinciai.eu:8050',
  apiKey: process.env.HIVEMIND_API_KEY || 'your-api-key',
  userId: 'demo-user',
  orgId: 'demo-org'
};

const hivemind = new HiveMindClient(config);

async function examples() {
  try {
    // 1. Check health
    console.log('1. Checking health...');
    const health = await hivemind.health();
    console.log('✓ Health:', health);
    console.log();

    // 2. Save a text memory
    console.log('2. Saving text memory...');
    const memory1 = await hivemind.save({
      title: 'Docker Best Practices',
      content: `Multi-stage builds reduce image size significantly.
Use Alpine Linux for smaller footprints.
Always pin base image versions for reproducibility.`,
      tags: ['docker', 'devops', 'best-practices'],
      project: 'knowledge-base'
    });
    console.log('✓ Saved:', memory1.memory_id || memory1.id);
    console.log();

    // 3. Save code
    console.log('3. Saving code snippet...');
    const codeMemory = await hivemind.saveCode({
      content: `async function fetchData() {
  const response = await fetch('/api/data');
  return response.json();
}`,
      filepath: 'src/utils/api.js',
      language: 'javascript',
      title: 'Async fetch helper'
    });
    console.log('✓ Saved code:', codeMemory.memory_id || codeMemory.id);
    console.log();

    // 4. Save conversation
    console.log('4. Saving conversation...');
    const chatMemory = await hivemind.saveConversation({
      title: 'React Hooks Discussion',
      messages: [
        { role: 'user', content: 'When should I use useEffect?' },
        { role: 'assistant', content: 'useEffect is for side effects like data fetching, subscriptions, or DOM mutations.' }
      ],
      platform: 'claude',
      tags: ['react', 'hooks']
    });
    console.log('✓ Saved conversation:', chatMemory.memory_id || chatMemory.id);
    console.log();

    // 5. Search
    console.log('5. Searching for "docker"...');
    const searchResults = await hivemind.search('docker', {
      limit: 5,
      tags: ['devops']
    });
    console.log('✓ Found', searchResults.length, 'results');
    searchResults.forEach(r => console.log(`  - ${r.title}`));
    console.log();

    // 6. AI Query
    console.log('6. Querying with AI...');
    const queryResult = await hivemind.query('What are Docker best practices?', {
      limit: 3
    });
    console.log('✓ Answer:', queryResult.answer || queryResult.response);
    console.log();

    // 7. List all memories
    console.log('7. Listing memories...');
    const listResult = await hivemind.list({ limit: 10 });
    console.log('✓ Total memories:', listResult.total || listResult.memories?.length);
    console.log();

    console.log('✅ All examples completed!');

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.statusCode) {
      console.error('   Status:', error.statusCode);
    }
  }
}

// Run examples
examples();
