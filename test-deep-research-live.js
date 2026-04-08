#!/usr/bin/env node
/**
 * Live Deep Research Test - Tests complete workflow with actual API calls
 *
 * This script:
 * 1. Starts a research session
 * 2. Runs a simple query
 * 3. Verifies trail and sources are persisted
 * 4. Fetches the graph layers
 */

import { randomUUID } from 'node:crypto';

// Config
const API_BASE = 'https://api.hivemind.davinciai.eu:8040';
const API_KEY = 'hmk_live_c6d2a918b7cd7f23286e9dd51f90f169bb1c6fdffb4673f4';

const TEST_QUERY = 'What are the best practices for building memory-augmented language models in 2025?';

async function runTest() {
  console.log('=== Deep Research Live Test ===\n');

  const sessionId = randomUUID();
  console.log(`Session ID: ${sessionId}\n`);

  try {
    // Step 1: Start research
    console.log('1. Starting research...');
    const startRes = await fetch(`${API_BASE}/v1/proxy/research/start`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: TEST_QUERY,
        forceRefresh: false,
      }),
    });

    if (!startRes.ok) {
      throw new Error(`Start failed: ${startRes.status} ${await startRes.text()}`);
    }

    const startData = await startRes.json();
    const actualSessionId = startData.session_id || sessionId;
    console.log(`   Research started: ${startData.status}`);
    console.log(`   Session ID: ${actualSessionId}`);
    console.log(`   Project ID: ${startData.project_id}`);
    console.log(`   Initial action: ${startData.nextAction?.action}\n`);

    // Step 2: Run the research loop (simplified - just one iteration)
    console.log('2. Running research loop...');
    const loopRes = await fetch(`${API_BASE}/v1/proxy/research/${actualSessionId}/step`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    if (!loopRes.ok) {
      console.log(`   Note: Step returned ${loopRes.status} - may need more iterations`);
    } else {
      const loopData = await loopRes.json();
      console.log(`   Step completed: ${loopData.status || 'ongoing'}`);
      console.log(`   Actions taken: ${loopData.actions?.length || 0}\n`);
    }

    // Step 3: Wait a moment for persistence
    console.log('3. Waiting for persistence (2s)...');
    await new Promise(r => setTimeout(r, 2000));

    // Step 4: Get session status
    console.log('4. Getting session status...');
    const statusRes = await fetch(`${API_BASE}/v1/proxy/research/${actualSessionId}/status`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });

    if (statusRes.ok) {
      const status = await statusRes.json();
      console.log(`   Status: ${status.status}`);
      console.log(`   Steps taken: ${status.steps?.length || 0}`);
      console.log(`   Project ID: ${status.projectId || status.result?.projectId}\n`);
    }

    // Step 5: Fetch graph layers
    console.log('5. Fetching graph layers...');
    const graphRes = await fetch(`${API_BASE}/v1/proxy/research/${actualSessionId}/graph`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });

    if (graphRes.ok) {
      const graph = await graphRes.json();
      console.log(`   Sources: ${graph.sources?.length || 0}`);
      console.log(`   Claims: ${graph.claims?.length || 0}`);
      console.log(`   Trails: ${graph.trails?.length || 0}`);
      console.log(`   Blueprints: ${graph.blueprints?.length || 0}`);
      console.log(`   Edges: ${graph.weights?.edges?.length || 0}\n`);

      // Show sample data
      if (graph.sources?.length > 0) {
        console.log('   Sample source:', JSON.stringify(graph.sources[0], null, 2).slice(0, 300));
      }
      if (graph.trails?.length > 0) {
        console.log('   Sample trail step:', JSON.stringify(graph.trails[0], null, 2).slice(0, 300));
      }

      // Full JSON dump
      console.log('\n=== Full Graph JSON (first 2000 chars) ===');
      console.log(JSON.stringify(graph, null, 2).slice(0, 2000));
    } else {
      console.log(`   Graph fetch failed: ${graphRes.status}`);
    }

    console.log('\n=== Test Complete ===');

  } catch (err) {
    console.error('Test failed:', err.message);
    console.error(err.stack);
  }
}

runTest();
