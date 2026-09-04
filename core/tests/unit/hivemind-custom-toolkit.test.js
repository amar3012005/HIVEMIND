import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HIVEMIND_TOOL_GROUPS } from '../../src/agent/connector-toolkits/hivemind-tool-groups.js';
import {
  buildHivemindCustomToolkit,
  composioSessionExperimentalFromToolkit,
  composioSlugFromNativeName,
  nativeNameFromComposioSlug,
} from '../../src/connectors/composio/hivemind-custom-toolkit.js';

function schemasForGroups() {
  return Object.values(HIVEMIND_TOOL_GROUPS).flatMap((group) => [...group.tools]).map((name) => ({
    type: 'function',
    function: {
      name,
      description: `${name} native HIVEMIND tool`,
      parameters: name === 'hivemind_recall'
        ? { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        : { type: 'object', properties: {} },
    },
  }));
}

test('custom toolkit registers every grouped HIVEMIND chat tool with native schemas', () => {
  const schemas = schemasForGroups();
  const toolkit = buildHivemindCustomToolkit({ schemas });
  const grouped = new Set(Object.values(HIVEMIND_TOOL_GROUPS).flatMap((group) => [...group.tools]));
  const nativeNames = toolkit.tools.map((tool) => tool.original_slug);
  for (const name of grouped) {
    assert.ok(nativeNames.includes(name), `missing ${name}`);
    const tool = toolkit.tools.find((row) => row.original_slug === name);
    assert.equal(tool.slug, composioSlugFromNativeName(name));
    assert.deepEqual(tool.input_schema, schemas.find((row) => row.function.name === name).function.parameters);
  }
  const recall = toolkit.tools.find((tool) => tool.original_slug === 'hivemind_recall');
  assert.ok(recall.input_schema.required.includes('query'));
  assert.equal(recall.preload, true);
  assert.equal(toolkit.tools.length, grouped.size);
});

test('group filter matches use_tools:false selectedGroups', () => {
  const toolkit = buildHivemindCustomToolkit({
    selectedGroups: ['hivemind-recall'],
    schemas: schemasForGroups(),
  });
  assert.ok(toolkit.tools.every((tool) => tool.group === 'hivemind-recall'));
  assert.ok(toolkit.tools.some((tool) => tool.original_slug === 'hivemind_recall'));
  assert.equal(toolkit.tools.some((tool) => tool.original_slug === 'hivemind_save_memory'), false);
});

test('session experimental payload uses Composio custom toolkit shape', () => {
  const experimental = composioSessionExperimentalFromToolkit(buildHivemindCustomToolkit({ schemas: schemasForGroups() }));
  assert.equal(experimental.custom_toolkits[0].slug, 'HIVEMIND');
  assert.ok(experimental.custom_toolkits[0].tools.length >= 20);
  assert.equal(nativeNameFromComposioSlug('HIVEMIND_RECALL'), 'hivemind_recall');
  assert.equal(nativeNameFromComposioSlug('LOCAL_HIVEMIND_HIVEMIND_RECALL'), 'hivemind_recall');
  assert.equal(nativeNameFromComposioSlug('LOCAL_HIVEMIND_RECALL'), 'hivemind_recall');
});
