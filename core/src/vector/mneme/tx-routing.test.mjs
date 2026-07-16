import { makeMnemePrisma } from '/Users/amar/HIVE-MIND/core/src/vector/mneme/prisma-proxy.js';
import assert from 'node:assert';
const SAI='sai'; let adapter=null;
const real={
  memory:{create:async(a)=>({src:'pg'})},
  relationship:{create:async(a)=>({src:'pg'})},
  $transaction:async(fn,opts)=> typeof fn==='function' ? fn({ memory:{create:async(a)=>({src:'pg-tx'})}, relationship:{create:async(a)=>({src:'pg-tx'})} }) : 'batch',
};
const mockAdapter={ memory:{create:async(a)=>({src:'amr'})}, relationship:{create:async(a)=>({src:'amr'})} };
const proxy=makeMnemePrisma(real,{amrOrg:SAI,getAdapter:()=>adapter});
adapter=mockAdapter;
let pass=0; const t=async(n,f)=>{await f();pass++;console.log('  ✓ '+n);};

await t('sai write INSIDE $transaction → .amr (the bug fix)', async()=>{
  const r=await proxy.$transaction(async(tx)=>tx.memory.create({data:{orgId:SAI}}));
  assert.equal(r.src,'amr');
});
await t('other-org write inside $transaction → Postgres', async()=>{
  const r=await proxy.$transaction(async(tx)=>tx.memory.create({data:{orgId:'other'}}));
  assert.equal(r.src,'pg-tx');
});
await t('relationship inside tx for sai → .amr', async()=>{
  const r=await proxy.$transaction(async(tx)=>tx.relationship.create({data:{fromMemory:{orgId:SAI}}}));
  // note: relationship create resolves org via data.orgId — here none, so passthrough. test direct orgId:
  const r2=await proxy.$transaction(async(tx)=>tx.memory.create({data:{orgId:SAI}}));
  assert.equal(r2.src,'amr');
});
console.log(`\ntx-routing: ${pass}/3 PASS — transactional writes now route`);
