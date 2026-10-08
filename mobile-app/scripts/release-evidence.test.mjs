import test from 'node:test';
import assert from 'node:assert/strict';
import { gates, validateReleaseEvidence } from './release-evidence.mjs';
const sha = 'a'.repeat(40);
const evidence = () => ({format:1,frontendSha:sha,platform:'android',device:'Test physical model / OS',verifiedAt:'2026-10-08T19:00:00Z',...Object.fromEntries(gates.map(key=>[key,{verified:true,evidence:'Recorded verification receipt'}]))});
test('release evidence binds platform and exact packaged source',()=>{validateReleaseEvidence(evidence(),sha,'android');assert.throws(()=>validateReleaseEvidence(evidence(),'b'.repeat(40),'android'));assert.throws(()=>validateReleaseEvidence(evidence(),sha,'ios'));});
test('false or blank verification cannot satisfy release',()=>{for(const key of gates){const value=evidence();value[key].verified=false;assert.throws(()=>validateReleaseEvidence(value,sha,'android'));value[key].verified=true;value[key].evidence=' ';assert.throws(()=>validateReleaseEvidence(value,sha,'android'));}});

test('every parity gate must be present',()=>{for(const key of gates){const value=evidence();delete value[key];assert.throws(()=>validateReleaseEvidence(value,sha,'android'));}});
