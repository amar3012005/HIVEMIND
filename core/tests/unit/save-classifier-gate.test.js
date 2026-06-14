import test from 'node:test';
import assert from 'node:assert/strict';
import { looksDeclarativeFact } from '../../src/agent/react-agent-v2.js';

test('declarative facts pass the save-classifier gate', () => {
  assert.equal(looksDeclarativeFact('Singulance is the new parent company of HIVEMIND and the rebranded name of Davinci AI'), true);
  assert.equal(looksDeclarativeFact('We rebranded Davinci AI to Singulance last week'), true);
  assert.equal(looksDeclarativeFact('Acme acquired Beta Corp and merged the teams'), true);
  assert.equal(looksDeclarativeFact('I prefer async communication over meetings'), true);
});

test('questions and recall commands do NOT pass the gate', () => {
  assert.equal(looksDeclarativeFact('what is Singulance'), false);
  assert.equal(looksDeclarativeFact('What is Singulance?'), false);
  assert.equal(looksDeclarativeFact('who is the parent company of HIVEMIND?'), false);
  assert.equal(looksDeclarativeFact('tell me about Davinci AI'), false);
  assert.equal(looksDeclarativeFact('is Singulance related to Davinci'), false);
  assert.equal(looksDeclarativeFact('show my notes on Acme'), false);
});

test('too-short / bare-entity messages do NOT pass', () => {
  assert.equal(looksDeclarativeFact('Singulance'), false);
  assert.equal(looksDeclarativeFact('Acme Corp'), false);
  assert.equal(looksDeclarativeFact(''), false);
});
