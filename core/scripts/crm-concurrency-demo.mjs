/** Actual local tunnel to synthetic isolated fixture only; no retry of writes. */
import fs from 'node:fs/promises';import crypto from 'node:crypto';import assert from 'node:assert/strict';
const root='/tmp/hivemind-crm-authenticated-preview-20261006/';const f=JSON.parse(await fs.readFile(root+'auth.json','utf8'));const r=JSON.parse(await fs.readFile(root+'report.json','utf8'));
const url='http://127.0.0.1:63001/api/app-runtime/apps/'+r.appId;const headers={Authorization:`Bearer ${f['1'].apiKey}`,'Content-Type':'application/json'};
const initial=await fetch(url,{headers});assert.equal(initial.status,200);let {app}=await initial.json();const checks=[];
for(let i=0;i<20;i++){
 const result=await Promise.all(['A','B'].map(async label=>{const response=await fetch(url,{method:'PATCH',headers,body:JSON.stringify({expectedVersion:app.version,spec:{...app.spec,name:`Concurrent synthetic ${i} ${label}`},operationId:crypto.randomUUID()})});return {status:response.status,data:await response.json()};}));
 assert.deepEqual(result.map(x=>x.status).sort(),[200,409],`Concurrent iteration ${i}: ${JSON.stringify(result)}`);
 app=result.find(x=>x.status===200).data.app;checks.push({iteration:i,statuses:[200,409],resultVersion:app.version});
}
await fs.writeFile(root+'concurrency-report.json',JSON.stringify({checks,realHttp:true,productionMutations:false},null,2));console.log(JSON.stringify({passed:checks.length,report:root+'concurrency-report.json'}));
