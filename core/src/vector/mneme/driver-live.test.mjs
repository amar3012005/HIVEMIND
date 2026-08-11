import { configureDriver, isMnemeOrg, wrapPrisma, amrRecall, amrWrite, __test } from '/Users/amar/HIVE-MIND/core/src/vector/mneme/driver.js';
import { loadBinding, MnemeMemoryBackend, MnemeRelationshipBackend, SidecarBackend } from '/Users/amar/HMFs/HIVEMIND/mneme/crate/mneme-node/amr-store-backend.mjs';
import assert from 'node:assert'; import { rmSync } from 'fs';
const bind = loadBinding('/Users/amar/HMFs/HIVEMIND/mneme/crate/mneme-node/singulance-amr.node');
const ROOT='/tmp/driver_live'; rmSync(ROOT,{recursive:true,force:true});
const ORG='org-sai-x';
process.env.MNEME_ORGS = ORG; __test._reset();
let pass=0; const t=async(n,f)=>{await f();pass++;console.log('  ✓ '+n);};
const _m=()=>({findMany:async()=>[{src:'pg'}],count:async()=>500,create:async()=>({src:'pg'}),upsert:async()=>({src:'pg'}),update:async()=>({src:'pg'}),delete:async()=>({src:'pg'}),createMany:async()=>({count:0}),findUnique:async()=>null});
const real={memory:_m(),relationship:_m(),sourceMetadata:_m(),knowledgeSegment:_m(),$transaction:async(f)=>typeof f==='function'?f(real):'b'};

await t('flag: isMnemeOrg parses MNEME_ORGS', ()=>{ assert.ok(isMnemeOrg(ORG)); assert.ok(!isMnemeOrg('other')); });
configureDriver({ backend:{openStore:(r,c,d)=>bind.MnemeStore.open(r,c,d),MnemeMemoryBackend,MnemeRelationshipBackend,SidecarBackend}, realPrisma:real, dataRoot:ROOT, dim:8 });
const prisma = wrapPrisma(real);

await t('proxy: sai memory.create → .amr (via driver)', async()=>{ await prisma.memory.create({data:{id:'d1',orgId:ORG,content:'driver fact',layer:'memory',isLatest:true}}); assert.equal(await prisma.memory.count({where:{orgId:ORG}}),1); });
await t('proxy: other org → Postgres', async()=>{ assert.equal((await prisma.memory.findMany({where:{orgId:'other'}}))[0].src,'pg'); });
await t('amrWrite: record+vector → .amr', async()=>{ await amrWrite(ORG,{id:'d2',orgId:ORG,content:'vectored fact',layer:'memory',isLatest:true,tags:['extracted-fact']}, [1,0,0,0,0,0,0,0]); assert.equal(await prisma.memory.count({where:{orgId:ORG}}),2); });
await t('amrRecall: filter-aware recall from .amr', ()=>{ const hits=amrRecall(ORG, [1,0,0,0,0,0,0,0], {must:[{key:'org_id',match:{value:ORG}}]}, 5, 0); assert.ok(Array.isArray(hits)&&hits.length>=1); assert.equal(hits[0].payload.org_id,ORG); });
await t('amrRecall non-.amr org → null', ()=>{ assert.equal(amrRecall('other',[1,0,0,0,0,0,0,0],null,5,0), null); });

await t('FK-child sourceMetadata by memoryId → .amr (getAllAdapters routing)', async()=>{ await prisma.sourceMetadata.upsert({where:{memoryId:'d1'},create:{id:'s1',memoryId:'d1',orgId:ORG,source:'kb'},update:{source:'kb2'}}); const r=await prisma.sourceMetadata.findUnique({where:{memoryId:'d1'}}); assert.ok(r&&r.source==='kb', 'FK-child routed to .amr, not PG'); });

console.log(`\ndriver seam (live .amr): ${pass}/6 — one config flip, one seam, real store`);
