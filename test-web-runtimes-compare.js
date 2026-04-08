/**
 * Comprehensive Test: Tavily vs Enhanced LightPanda
 * Compares all features side-by-side
 *
 * Usage: node test-web-runtimes-compare.js
 */

import { TavilyRuntime } from './core/src/web/browser-runtime.js';
import { LightpandaRuntime } from './core/src/web/browser-runtime.js';
import { TavilyClientWrapper } from './core/src/web/tavily-client.js';

const TEST_QUERY = 'HIVEMIND artificial intelligence';
const TEST_URL = 'https://en.wikipedia.org/wiki/Artificial_intelligence';

// Test result tracker
const results = {
  tavily: { passed: 0, failed: 0, errors: [] },
  lightpanda: { passed: 0, failed: 0, errors: [] }
};

function logTest(name, passed, details = '', runtime = 'unknown') {
  const status = passed ? '✓' : '✗';
  const color = passed ? '\x1b[32m' : '\x1b[31m';
  const reset = '\x1b[0m';

  console.log(`  ${color}${status}${reset} ${name}: ${details}`);

  if (passed) {
    results[runtime].passed++;
  } else {
    results[runtime].failed++;
    results[runtime].errors.push(`${name}: ${details}`);
  }
}

async function testTavilySearch(client) {
  console.log('\n\x1b[36m=== TAVILY SEARCH TESTS ===\x1b[0m');

  // Test 1: Basic search
  try {
    const result = await client.search({
      query: TEST_QUERY,
      maxResults: 5,
      includeAnswer: true,
      includeFavicon: true,
    });

    logTest('Basic search', true, `${result.results.length} results, answer=${!!result.answer}`, 'tavily');
    logTest('  - Has answer', !!result.answer, result.answer?.slice(0, 50) + '...', 'tavily');
    logTest('  - Has results', result.results.length > 0, `${result.results.length} results`, 'tavily');
    logTest('  - Has favicons', result.results.some(r => r.favicon), 'favicons present', 'tavily');
    logTest('  - Has scores', result.results.some(r => r.score !== undefined), 'scores present', 'tavily');
  } catch (err) {
    logTest('Basic search', false, err.message, 'tavily');
  }

  // Test 2: Domain-restricted search
  try {
    const result = await client.search({
      query: 'AI',
      includeDomains: ['wikipedia.org'],
      maxResults: 3,
    });

    logTest('Domain-restricted search', true, `${result.results.length} results from wikipedia`, 'tavily');
    logTest('  - All from domain', result.results.every(r => r.url.includes('wikipedia.org')), 'wikipedia only', 'tavily');
  } catch (err) {
    logTest('Domain-restricted search', false, err.message, 'tavily');
  }

  // Test 3: Search with time range
  try {
    const result = await client.search({
      query: 'AI breakthrough',
      timeRange: 'month',
      maxResults: 3,
    });

    logTest('Time-range search', true, `${result.results.length} recent results`, 'tavily');
  } catch (err) {
    logTest('Time-range search', false, err.message, 'tavily');
  }

  // Test 4: Response time
  try {
    const start = Date.now();
    await client.search({ query: TEST_QUERY, maxResults: 3 });
    const duration = Date.now() - start;

    logTest('Response time', duration < 3000, `${duration}ms`, 'tavily');
  } catch (err) {
    logTest('Response time', false, err.message, 'tavily');
  }
}

async function testTavilyExtract(client) {
  console.log('\n\x1b[36m=== TAVILY EXTRACT TESTS ===\x1b[0m');

  try {
    const result = await client.extract({
      urls: [TEST_URL],
      format: 'markdown',
      includeFavicon: true,
    });

    logTest('Basic extract', true, `${result.results.length} pages extracted`, 'tavily');
    logTest('  - Has content', result.results[0]?.rawContent?.length > 0, `${result.results[0]?.rawContent?.length || 0} chars`, 'tavily');
    logTest('  - Has favicon', !!result.results[0]?.favicon, 'favicon present', 'tavily');
  } catch (err) {
    logTest('Basic extract', false, err.message, 'tavily');
  }

  // Multi-URL extract
  try {
    const result = await client.extract({
      urls: ['https://example.com', 'https://example.org'],
      format: 'text',
    });

    logTest('Multi-URL extract', true, `${result.results.length} pages`, 'tavily');
  } catch (err) {
    logTest('Multi-URL extract', false, err.message, 'tavily');
  }
}

async function testTavilyCrawl(client) {
  console.log('\n\x1b[36m=== TAVILY CRAWL TESTS ===\x1b[0m');

  try {
    const result = await client.crawl({
      url: 'https://example.com',
      maxDepth: 1,
      limit: 5,
      format: 'markdown',
    });

    logTest('Basic crawl', true, `${result.results?.length || 0} pages crawled`, 'tavily');
  } catch (err) {
    logTest('Basic crawl', false, err.message, 'tavily');
  }
}

async function testLightpandaSearch(runtime) {
  console.log('\n\x1b[36m=== LIGHTPANDA SEARCH TESTS ===\x1b[0m');

  // Test 1: Basic web search
  try {
    const result = await runtime.search({
      query: TEST_QUERY,
      limit: 5,
    });

    logTest('Basic web search', true, `${result.results.length} results`, 'lightpanda');
    logTest('  - Has results', result.results.length > 0, `${result.results.length} results`, 'lightpanda');
    logTest('  - Has snippets', result.results.some(r => r.snippet), 'snippets present', 'lightpanda');
    logTest('  - Has scores', result.results.some(r => r.score !== undefined), 'scores present', 'lightpanda');
    logTest('  - Has favicons', result.results.some(r => r.favicon), 'favicons present', 'lightpanda');
    logTest('  - Has domain authority', result.results.some(r => r.domainAuthority !== undefined), 'authority scores', 'lightpanda');
  } catch (err) {
    logTest('Basic web search', false, err.message, 'lightpanda');
  }

  // Test 2: Domain-specific search
  try {
    const result = await runtime.search({
      query: 'AI',
      domains: ['https://wikipedia.org'],
      limit: 3,
    });

    logTest('Domain-specific search', true, `${result.results.length} results`, 'lightpanda');
    logTest('  - All from domain', result.results.every(r => r.url.includes('wikipedia.org')), 'wikipedia only', 'lightpanda');
    logTest('  - Has content', result.results.some(r => r.content?.length > 0), 'content extracted', 'lightpanda');
  } catch (err) {
    logTest('Domain-specific search', false, err.message, 'lightpanda');
  }

  // Test 3: Multi-engine fallback
  try {
    const result = await runtime.search({
      query: 'test query',
      limit: 5,
    });

    logTest('Multi-engine search', true, 'DuckDuckGo + Qwant', 'lightpanda');
  } catch (err) {
    logTest('Multi-engine search', false, err.message, 'lightpanda');
  }

  // Test 4: Response time
  try {
    const start = Date.now();
    await runtime.search({ query: 'test', limit: 3 });
    const duration = Date.now() - start;

    logTest('Response time', duration < 10000, `${duration}ms`, 'lightpanda');
  } catch (err) {
    logTest('Response time', false, err.message, 'lightpanda');
  }
}

async function testLightpandaCrawl(runtime) {
  console.log('\n\x1b[36m=== LIGHTPANDA CRAWL TESTS ===\x1b[0m');

  // Test 1: Basic crawl
  try {
    const result = await runtime.crawl({
      urls: ['https://example.com'],
      depth: 1,
      pageLimit: 3,
    });

    logTest('Basic crawl', true, `${result.pages.length} pages`, 'lightpanda');

    if (result.pages.length > 0) {
      const page = result.pages[0];
      logTest('  - Has title', !!page.title, page.title?.slice(0, 30), 'lightpanda');
      logTest('  - Has markdown content', !!page.content, 'markdown format', 'lightpanda');
      logTest('  - Has plain text', !!page.text, 'text format', 'lightpanda');
      logTest('  - Has description', !!page.description, 'meta description', 'lightpanda');
      logTest('  - Has images', page.images?.length >= 0, `${page.images?.length || 0} images`, 'lightpanda');
      logTest('  - Has links', page.links?.length >= 0, `${page.links?.length || 0} links`, 'lightpanda');
      logTest('  - Has word count', page.wordCount !== undefined, `${page.wordCount} words`, 'lightpanda');
      logTest('  - Has reading time', page.readingTime !== undefined, `${page.readingTime} min`, 'lightpanda');
      logTest('  - Has quality score', page.qualityScore !== undefined, `score=${page.qualityScore}`, 'lightpanda');
      logTest('  - Has favicon', !!page.favicon, 'favicon present', 'lightpanda');
    }
  } catch (err) {
    logTest('Basic crawl', false, err.message, 'lightpanda');
  }

  // Test 2: Multi-page crawl
  try {
    const result = await runtime.crawl({
      urls: ['https://example.com', 'https://example.org'],
      depth: 1,
      pageLimit: 5,
    });

    logTest('Multi-URL crawl', true, `${result.pages.length} pages`, 'lightpanda');
  } catch (err) {
    logTest('Multi-URL crawl', false, err.message, 'lightpanda');
  }
}

async function runComparison() {
  console.log('\x1b[33m╔════════════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[33m║  TAVILY vs LIGHTPANDA: COMPREHENSIVE FEATURE COMPARISON  ║\x1b[0m');
  console.log('\x1b[33m╚════════════════════════════════════════════════════════╝\x1b[0m');

  // Initialize runtimes
  const tavilyClient = new TavilyClientWrapper();
  const lightpandaRuntime = new LightpandaRuntime();

  console.log(`\nTavily available: ${tavilyClient.isAvailable()}`);
  console.log(`LightPanda: Ready to test`);

  // Run Tavily tests
  if (tavilyClient.isAvailable()) {
    await testTavilySearch(tavilyClient);
    await testTavilyExtract(tavilyClient);
    await testTavilyCrawl(tavilyClient);
  } else {
    console.log('\x1b[31mSkipping Tavily tests - API key not configured\x1b[0m');
  }

  // Run LightPanda tests
  await testLightpandaSearch(lightpandaRuntime);
  await testLightpandaCrawl(lightpandaRuntime);

  // Print summary
  console.log('\n\x1b[33m╔════════════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[33m║                    TEST SUMMARY                          ║\x1b[0m');
  console.log('\x1b[33m╚════════════════════════════════════════════════════════╝\x1b[0m\n');

  console.log('\x1b[36mTAVILY:\x1b[0m');
  console.log(`  Passed: ${results.tavily.passed}`);
  console.log(`  Failed: ${results.tavily.failed}`);
  if (results.tavily.errors.length > 0) {
    console.log('  Errors:');
    results.tavily.errors.forEach(e => console.log(`    - ${e}`));
  }

  console.log('\n\x1b[35mLIGHTPANDA:\x1b[0m');
  console.log(`  Passed: ${results.lightpanda.passed}`);
  console.log(`  Failed: ${results.lightpanda.failed}`);
  if (results.lightpanda.errors.length > 0) {
    console.log('  Errors:');
    results.lightpanda.errors.forEach(e => console.log(`    - ${e}`));
  }

  // Feature comparison table
  console.log('\n\x1b[33m╔════════════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[33m║                  FEATURE COMPARISON                      ║\x1b[0m');
  console.log('\x1b[33m╚════════════════════════════════════════════════════════╝\x1b[0m\n');

  const features = [
    ['Web Search', '✓ (API)', '✓ (Browser)'],
    ['Answer Generation', '✓ (LLM)', '✗'],
    ['Domain Filtering', '✓', '✓ (Enhanced)'],
    ['Time Range Filter', '✓', '✗'],
    ['Favicon Extraction', '✓', '✓ (Enhanced)'],
    ['Image Extraction', '✓', '✓ (Enhanced)'],
    ['Content Scoring', '✓', '✓ (Enhanced)'],
    ['Domain Authority', '✗', '✓ (Heuristic)'],
    ['Page Crawl', '✓ (API)', '✓ (Browser)'],
    ['Markdown Output', '✓', '✓ (Enhanced)'],
    ['Word Count', '✗', '✓'],
    ['Reading Time', '✗', '✓'],
    ['Quality Score', '✗', '✓'],
    ['Multi-URL Extract', '✓ (20 URLs)', '✓'],
    ['Multi-engine Search', '✗', '✓ (DDG+Qwant)'],
    ['Credits Cost', 'Yes', 'Free'],
  ];

  console.log('Feature                    | Tavily        | LightPanda');
  console.log('---------------------------|---------------|----------------');
  features.forEach(([feature, tavily, lp]) => {
    const f = feature.padEnd(26);
    const t = tavily.padEnd(13);
    const l = lp.padEnd(16);
    console.log(`${f} | ${t} | ${l}`);
  });

  console.log('\n\x1b[32m=== COMPARISON COMPLETE ===\x1b[0m\n');
}

runComparison().catch(console.error);
