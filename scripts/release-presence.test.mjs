import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
test('expired claim cleanup preserves requesting release identity and scope', async()=>{
 const root=await mkdtemp(join(tmpdir(),'release-presence-test-'));
 try {
  await mkdir(join(root,'claims'));
  await writeFile(join(root,'claims','expired'), 'session=expired\nservices=core,harness-runner\nsha=old\nphase=building\nupdated=1\n');
  const env={...process.env,RELEASE_PRESENCE_DIR:root,RELEASE_PRESENCE_TTL_SECONDS:'1800'};
  execFileSync('bash',['scripts/release-presence.sh','claim','--session','mobile-control-test','--services','control-plane','--sha','new','--summary','test'],{env});
  const claim=await readFile(join(root,'claims','mobile-control-test'),'utf8');
  assert.match(claim,/session=mobile-control-test/);assert.match(claim,/services=control-plane/);assert.match(claim,/sha=new/);
  await assert.rejects(()=>readFile(join(root,'claims','expired')));
  const events=(await readFile(join(root,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events[0].session,'expired');assert.equal(events[0].event,'expired');assert.equal(events[1].session,'mobile-control-test');assert.equal(events[1].result,'ok');
  execFileSync('bash',['scripts/release-presence.sh','heartbeat','--session','mobile-control-test','--phase','verified'],{env});
  assert.match(await readFile(join(root,'claims','mobile-control-test'),'utf8'),/phase=verified/);
 }finally{await rm(root,{recursive:true,force:true});}
});
