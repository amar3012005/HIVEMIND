import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStructuredRecallQuery } from '../../src/agent/structured-recall-query.js';

test('structured recall compiles the planner objective into one retrieval request', () => {
  assert.equal(
    buildStructuredRecallQuery(
      ['Was wissen wir ueber die Produktfamilie?', 'Was wissen wir ueber die Produktfamilie?'],
      'Alle bekannten Produkte mit Kategorie und Beleg auflisten',
    ),
    'Was wissen wir ueber die Produktfamilie?\nRetrieval objective: Alle bekannten Produkte mit Kategorie und Beleg auflisten',
  );
  assert.equal(buildStructuredRecallQuery(['same'], 'same'), 'same');
});
