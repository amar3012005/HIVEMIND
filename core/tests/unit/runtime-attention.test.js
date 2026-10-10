import test from 'node:test';import assert from 'node:assert/strict';
import {assessRuntimeAttention} from '../../src/connectors/composio/runtime-attention.js';
test('Runtime decision delegates to native service without provider inference',async()=>{const event={id:'persisted'};let seen;const result=await assessRuntimeAttention({event,bridge:{assess:async row=>{seen=row;return {action:'notify'}}}});assert.equal(seen,event);assert.equal(result.action,'notify')});
test('missing native service has explicit unavailable result',async()=>{assert.equal((await assessRuntimeAttention({event:{}})).reason,'decision_unavailable')});
