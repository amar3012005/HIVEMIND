import { matchesFilter, toPayload } from '/Users/amar/HIVE-MIND/core/src/vector/mneme/mneme-recall.js';
import assert from 'node:assert';
let pass=0; const t=(n,f)=>{f();pass++;console.log('  ✓ '+n);};
const rec = { id:'m1', orgId:'sai', userId:'u1', project:'projA', projectIds:['projA'], memoryType:'fact', isLatest:true, layer:'memory', scope:'project', visibility:'organization', tags:['entity:solvis','extracted-fact'] };

t('org_id must (camelCase mapping)', ()=>{ assert.ok(matchesFilter(rec,{must:[{key:'org_id',match:{value:'sai'}}]})); assert.ok(!matchesFilter(rec,{must:[{key:'org_id',match:{value:'other'}}]})); });
t('project must — scoped recall', ()=>{ assert.ok(matchesFilter(rec,{must:[{key:'project',match:{value:'projA'}}]})); assert.ok(!matchesFilter(rec,{must:[{key:'project',match:{value:'projB'}}]})); });
t('layer must — memory only', ()=>{ assert.ok(matchesFilter(rec,{must:[{key:'layer',match:{value:'memory'}}]})); assert.ok(!matchesFilter(rec,{must:[{key:'layer',match:{value:'evidence'}}]})); });
t('must_not promoted-from-segment (tags array)', ()=>{ assert.ok(matchesFilter(rec,{must_not:[{key:'tags',match:{value:'promoted-from-segment'}}]})); const promo={...rec,tags:['promoted-from-segment']}; assert.ok(!matchesFilter(promo,{must_not:[{key:'tags',match:{value:'promoted-from-segment'}}]})); });
t('entity tag must (array contains)', ()=>{ assert.ok(matchesFilter(rec,{must:[{key:'tags',match:{value:'entity:solvis'}}]})); });
t('is_latest must', ()=>{ assert.ok(matchesFilter(rec,{must:[{key:'is_latest',match:{value:true}}]})); assert.ok(!matchesFilter({...rec,isLatest:false},{must:[{key:'is_latest',match:{value:true}}]})); });
t('match any (project_ids)', ()=>{ assert.ok(matchesFilter(rec,{must:[{key:'project_ids',match:{any:['projA','projZ']}}]})); });
t('combined must (org + layer + scope) + must_not', ()=>{ assert.ok(matchesFilter(rec,{must:[{key:'org_id',match:{value:'sai'}},{key:'layer',match:{value:'memory'}}],must_not:[{key:'tags',match:{value:'promoted-from-segment'}}]})); });
t('toPayload → snake_case for pipeline', ()=>{ const p=toPayload(rec); assert.equal(p.memory_id,'m1'); assert.equal(p.org_id,'sai'); assert.equal(p.is_latest,true); assert.deepEqual(p.tags,rec.tags); });
console.log(`\nrecall filter parity: ${pass}/9 — the pipeline's own filter applies to .amr records`);
