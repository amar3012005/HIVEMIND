/**
 * Test script for Tavily integration
 * Run: node test-tavily.js
 */

import { getTavilyClient } from './core/src/web/tavily-client.js';

async function testTavily() {
  console.log('=== Tavily Integration Test ===\n');

  const client = getTavilyClient();

  if (!client.isAvailable()) {
    console.error('ERROR: Tavily API not configured. Set TAVILY_API_KEY environment variable.');
    process.exit(1);
  }

  console.log('Tavily client initialized successfully.\n');

  // Test 1: Search
  console.log('Test 1: Search API');
  try {
    const searchResult = await client.search({
      query: 'What is HIVEMIND?',
      maxResults: 3,
      includeAnswer: true,
    });
    console.log('  Search succeeded!');
    console.log('  Answer:', searchResult.answer?.slice(0, 100) || 'N/A');
    console.log('  Results:', searchResult.results.length);
    console.log('  Credits used:', searchResult.creditsUsed);
    console.log('  Response time:', searchResult.responseTimeMs, 'ms\n');
  } catch (err) {
    console.error('  Search failed:', err.message);
  }

  // Test 2: Extract
  console.log('Test 2: Extract API');
  try {
    const extractResult = await client.extract({
      urls: ['https://example.com'],
      format: 'markdown',
    });
    console.log('  Extract succeeded!');
    console.log('  Results:', extractResult.results.length);
    console.log('  Content length:', extractResult.results[0]?.rawContent?.length || 0, 'chars');
    console.log('  Credits used:', extractResult.creditsUsed);
    console.log('  Response time:', extractResult.responseTimeMs, 'ms\n');
  } catch (err) {
    console.error('  Extract failed:', err.message);
  }

  // Test 3: Telemetry
  console.log('Test 3: Telemetry');
  const telemetry = client.getTelemetry();
  console.log('  Total requests:', telemetry.totalRequests);
  console.log('  Successes:', telemetry.successes);
  console.log('  Failures:', telemetry.failures);
  console.log('  Credits used:', telemetry.creditsUsed);
  console.log('  Avg response time:', telemetry.avgResponseTimeMs, 'ms\n');

  console.log('=== All tests completed ===');
}

testTavily().catch(console.error);
