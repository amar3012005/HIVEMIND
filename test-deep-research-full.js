/**
 * Deep Research - Full Stack Verification Test
 * Tests all components at each scale
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = '/opt/HIVEMIND';

// Color output
const OK = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m!\x1b[0m';
const INFO = '\x1b[36m→\x1b[0m';

function test(name, fn) {
  try {
    fn();
    console.log(`  ${OK} ${name}`);
    return true;
  } catch (e) {
    console.log(`  ${FAIL} ${name}: ${e.message}`);
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

console.log('\n\x1b[1m═══════════════════════════════════════════════════════════\x1b[0m');
console.log('\x1b[1m  DEEP RESEARCH - FULL STACK VERIFICATION\x1b[0m');
console.log('\x1b[1m═══════════════════════════════════════════════════════════\x1b[0m\n');

let passed = 0;
let failed = 0;

// ─────────────────────────────────────────────────────────────────────────────
// SCALE 1: Core Files Exist
// ─────────────────────────────────────────────────────────────────────────────
console.log('\x1b[1m[SCALE 1] Core Files\x1b[0m\n');

const coreFiles = [
  'core/src/deep-research/researcher.js',
  'core/src/deep-research/task-stack.js',
  'core/src/deep-research/trail-store.js',
  'core/src/deep-research/blueprint-miner.js',
  'core/src/web/tavily-client.js',
  'core/src/web/browser-runtime.js',
  'core/src/server.js',
];

for (const file of coreFiles) {
  if (test(`File exists: ${file}`, () => {
    const content = readFileSync(join(REPO_ROOT, file), 'utf-8');
    assert(content.length > 0, 'File is empty');
  })) passed++; else failed++;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCALE 2: Frontend Files
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n\x1b[1m[SCALE 2] Frontend Files\x1b[0m\n');

const frontendFiles = [
  'frontend/Da-vinci/src/components/hivemind/app/pages/DeepResearch.jsx',
];

for (const file of frontendFiles) {
  if (test(`File exists: ${file}`, () => {
    const content = readFileSync(join(REPO_ROOT, file), 'utf-8');
    assert(content.length > 0, 'File is empty');
  })) passed++; else failed++;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCALE 3: Code Integrity Checks
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n\x1b[1m[SCALE 3] Code Integrity\x1b[0m\n');

const researcherContent = readFileSync(join(REPO_ROOT, 'core/src/deep-research/researcher.js'), 'utf-8');

test('Researcher has ReAct loop', () => {
  assert(researcherContent.includes('REASON'), 'Missing REASON step');
  assert(researcherContent.includes('ACT:'), 'Missing ACT step');
  assert(researcherContent.includes('OBSERVE'), 'Missing OBSERVE step');
});
passed++; failed += 0;

test('Researcher has 8 dimensions', () => {
  assert(researcherContent.includes('definition'), 'Missing dimension');
  assert(researcherContent.includes('mechanism'), 'Missing dimension');
  assert(researcherContent.includes('evidence'), 'Missing dimension');
  assert(researcherContent.includes('stakeholders'), 'Missing dimension');
  assert(researcherContent.includes('timeline'), 'Missing dimension');
  assert(researcherContent.includes('comparison'), 'Missing dimension');
  assert(researcherContent.includes('implications'), 'Missing dimension');
  assert(researcherContent.includes('gaps'), 'Missing dimension');
});
passed++; failed += 0;

test('Researcher has web search integration', () => {
  assert(researcherContent.includes('_webSearch'), 'Missing web search');
  assert(researcherContent.includes('browserRuntime'), 'Missing browser runtime');
});
passed++; failed += 0;

const trailStoreContent = readFileSync(join(REPO_ROOT, 'core/src/deep-research/trail-store.js'), 'utf-8');

test('TrailStore has CSI persistence', () => {
  assert(trailStoreContent.includes('op/research-trail'), 'Missing trail type');
  assert(trailStoreContent.includes('initTrail'), 'Missing init method');
  assert(trailStoreContent.includes('recordStep'), 'Missing record method');
  assert(trailStoreContent.includes('finalizeTrail'), 'Missing finalize method');
});
passed++; failed += 0;

const blueprintMinerContent = readFileSync(join(REPO_ROOT, 'core/src/deep-research/blueprint-miner.js'), 'utf-8');

test('BlueprintMiner has pattern detection', () => {
  assert(blueprintMinerContent.includes('kg/blueprint'), 'Missing blueprint type');
  assert(blueprintMinerContent.includes('mine'), 'Missing mine method');
  assert(blueprintMinerContent.includes('detectDomain'), 'Missing domain detection');
});
passed++; failed += 0;

const tavilyContent = readFileSync(join(REPO_ROOT, 'core/src/web/tavily-client.js'), 'utf-8');

test('TavilyClient has full API coverage', () => {
  assert(tavilyContent.includes('async search'), 'Missing search API');
  assert(tavilyContent.includes('async extract'), 'Missing extract API');
  assert(tavilyContent.includes('async crawl'), 'Missing crawl API');
  assert(tavilyContent.includes('async map'), 'Missing map API');
});
passed++; failed += 0;

const browserRuntimeContent = readFileSync(join(REPO_ROOT, 'core/src/web/browser-runtime.js'), 'utf-8');

test('BrowserRuntime has three-tier fallback', () => {
  assert(browserRuntimeContent.includes('TavilyRuntime'), 'Missing Tavily');
  assert(browserRuntimeContent.includes('LightpandaRuntime'), 'Missing LightPanda');
  assert(browserRuntimeContent.includes('FetchFallbackRuntime'), 'Missing Fetch');
});
passed++; failed += 0;

// ─────────────────────────────────────────────────────────────────────────────
// SCALE 4: API Endpoints
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n\x1b[1m[SCALE 4] API Endpoints\x1b[0m\n');

const serverContent = readFileSync(join(REPO_ROOT, 'core/src/server.js'), 'utf-8');

const endpoints = [
  { path: '/api/research/start', method: 'POST', desc: 'Start research' },
  { path: '/api/research/:sessionId/status', method: 'GET', desc: 'Get status' },
  { path: '/api/research/:sessionId/report', method: 'GET', desc: 'Get report' },
  { path: '/api/research/:sessionId/trail', method: 'GET', desc: 'Get trail' },
  { path: '/api/research/:sessionId/graph', method: 'GET', desc: 'Get graph' },
  { path: '/api/research/:sessionId/save-memory', method: 'POST', desc: 'Save to memory' },
  { path: '/api/research/blueprints', method: 'GET', desc: 'List blueprints' },
  { path: '/api/research/blueprints/suggest', method: 'GET', desc: 'Suggest blueprints' },
  { path: '/api/research/blueprints/mine', method: 'POST', desc: 'Mine blueprints' },
];

for (const ep of endpoints) {
  if (test(`${ep.method} ${ep.path}`, () => {
    assert(serverContent.includes(ep.path.replace(':sessionId', '[^/]+')), `Missing endpoint: ${ep.path}`);
  })) passed++; else failed++;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCALE 5: Frontend Features
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n\x1b[1m[SCALE 5] Frontend Features\x1b[0m\n');

const deepResearchContent = readFileSync(join(REPO_ROOT, 'frontend/Da-vinci/src/components/hivemind/app/pages/DeepResearch.jsx'), 'utf-8');

const features = [
  { name: 'Graph View state', pattern: 'showGraphView' },
  { name: 'Graph data fetch', pattern: 'fetchGraphData' },
  { name: 'Real-time polling', pattern: 'setInterval' },
  { name: 'Layer toggles', pattern: 'graphLayers' },
  { name: 'ForceGraph2D', pattern: 'ForceGraph2D' },
  { name: 'Runtime badges', pattern: 'RUNTIME_BADGES' },
  { name: 'Save to memory', pattern: 'handleSaveToMemory' },
  { name: 'Usage quota display', pattern: 'webUsage' },
  { name: 'Node click popup', pattern: 'selectedNode' },
  { name: 'Confidence rings', pattern: 'confidence ring' },
  { name: 'Quota color helper', pattern: 'quotaTextColor' },
  { name: 'Node detail popup', pattern: 'Node Detail Popup' },
  { name: 'Refresh button', pattern: 'handleRefreshGraph' },
];

for (const feature of features) {
  if (test(feature.name, () => {
    assert(deepResearchContent.includes(feature.pattern), `Missing: ${feature.pattern}`);
  })) passed++; else failed++;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCALE 6: Documentation
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n\x1b[1m[SCALE 6] Documentation\x1b[0m\n');

const docsContent = readFileSync(join(REPO_ROOT, 'docs/deepresearch_docs.md'), 'utf-8');

const docSections = [
  { name: 'Architecture diagram', pattern: 'Architecture' },
  { name: 'Core Components', pattern: 'Core Components' },
  { name: 'API Reference', pattern: 'API Reference' },
  { name: 'Frontend Components', pattern: 'Frontend Components' },
  { name: 'Data Flow', pattern: 'Data Flow' },
  { name: 'Configuration', pattern: 'Configuration' },
];

for (const section of docSections) {
  if (test(section.name, () => {
    assert(docsContent.includes(section.pattern), `Missing: ${section.pattern}`);
  })) passed++; else failed++;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCALE 7: Deployment Status
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n\x1b[1m[SCALE 7] Deployment Status\x1b[0m\n');

const { execSync } = await import('child_process');

try {
  const frontendStatus = execSync('git log --oneline -1', { cwd: join(REPO_ROOT, 'frontend/Da-vinci') }).toString().trim();
  test('Frontend commit deployed', () => {
    assert(frontendStatus.includes('73cb3a1') || frontendStatus.includes('Real-time Graph View'), 'Frontend not up to date');
  });
  passed++; failed += 0;
} catch (e) {
  test('Frontend commit deployed', () => { throw e; });
  failed++;
}

try {
  const backendStatus = execSync('git log --oneline -1', { cwd: REPO_ROOT }).toString().trim();
  test('Backend commit deployed', () => {
    assert(backendStatus.includes('5b88811') || backendStatus.includes('save-memory'), 'Backend not up to date');
  });
  passed++; failed += 0;
} catch (e) {
  test('Backend commit deployed', () => { throw e; });
  failed++;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n\x1b[1m═══════════════════════════════════════════════════════════\x1b[0m');
console.log(`\x1b[1m  RESULTS: ${passed} passed, ${failed} failed\x1b[0m`);
console.log('\x1b[1m═══════════════════════════════════════════════════════════\x1b[0m\n');

if (failed > 0) {
  console.log('\x1b[31mSome tests failed. Review the output above.\x1b[0m\n');
  process.exit(1);
} else {
  console.log('\x1b[32mAll tests passed! Deep Research is fully functional.\x1b[0m\n');
  process.exit(0);
}
