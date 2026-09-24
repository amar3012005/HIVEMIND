import test from 'node:test';
import assert from 'node:assert/strict';
import { filterMemoriesByEntities, loadSelectedEntityLinkMatches } from '../../src/memory/selected-entity-filter.js';

test('one verified identity group accepts an exact alias or a linked duplicate, but not textual neighbors', async () => {
  const memories = [
    { id: 'linked', tags: [], content: 'A saved incorporation decision.' },
    { id: 'alias', tags: ['entity:chennarapu-ramasantoshi'] },
    { id: 'neighbor', tags: ['entity:rama-sharma'], content: 'Rama Sharma was mentioned.' },
    { id: 'text-only', tags: [], content: 'Rama Santhoshi appears in this unrelated message.' },
  ];
  const group = [{ entity_ids: ['rama-id-a', 'rama-id-b'], canonical_entity_ids: ['rama-id-a', 'rama-id-b'], names: ['Rama Santhoshi', 'Chennarapu Ramasantoshi'] }];
  const prisma = { memoryEntityLink: { findMany: async ({ where }) => {
    assert.deepEqual(where.memoryId.in, ['linked', 'alias', 'neighbor', 'text-only']);
    assert.deepEqual(where.entityId.in, ['rama-id-a', 'rama-id-b']);
    return [{ memoryId: 'linked', entityId: 'rama-id-b' }];
  } } };
  const links = await loadSelectedEntityLinkMatches(prisma, group, memories);
  assert.deepEqual(filterMemoriesByEntities(memories, ['Rama Santhoshi'], {
    mode: 'must', strictEntitySelection: true, entityGroups: group, entityLinkGroupMatches: links,
  }).map((memory) => memory.id), ['linked', 'alias']);
});

test('separately selected canonical identities retain AND semantics', () => {
  const memories = [
    { id: 'one-only', tags: ['entity:rama-santhoshi'] },
    { id: 'both', tags: ['entity:rama-santhoshi', 'entity:singulance'] },
    { id: 'mention-only', content: 'Rama Santhoshi and Singulance are both mentioned.' },
  ];
  const groups = [
    { entity_ids: ['rama'], names: ['Rama Santhoshi', 'Rama'] },
    { entity_ids: ['singulance'], names: ['SINGULANCE'] },
  ];
  assert.deepEqual(filterMemoriesByEntities(memories, [], {
    mode: 'must', strictEntitySelection: true, entityGroups: groups,
  }).map((memory) => memory.id), ['both']);
});
