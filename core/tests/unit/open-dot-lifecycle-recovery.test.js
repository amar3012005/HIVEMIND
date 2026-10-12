import assert from 'node:assert/strict';
import { recoverBoundOpenDotLifecycles, lifecycleDeliveryIdentity } from '../../src/employees/open-dot-lifecycle-recovery.js';
const employee=()=>({id:'b5fd56ec-8285-40cc-8e7a-6df2f9636105',orgId:'7dd77134-c18d-4e46-a235-dbacb3434b74',createdBy:'3e45a122-df12-4077-a4f7-06f6e2fdad09',status:'draft',persona:'saved',avatarUrl:'untouched',policyRules:{other:{preserve:true},open_dot_employee:{version:1,state:'bound',execution_backend:'open-dot',dot_id:'dot_fixture',binding_revision:1},native_lifecycle:{version:1,phase:'active',kind:'durable',creation_hash:'a'.repeat(64),profile_stage:'responsibilities',profile_revision:1}}});
function fixture(){let row=employee(),at=100000,admin=true,checks=0,tail=Promise.resolve();
 const tx={ $queryRawUnsafe:async()=>[],digitalEmployee:{findUnique:async()=>structuredClone(row),update:async({data})=>{row={...row,...structuredClone(data)};return row;}},userOrganization:{findUnique:async()=>{checks++;return{isActive:admin,role:'owner'};}}};
 const db={$queryRawUnsafe:async()=>[{id:row.id}],$transaction:work=>{const next=tail.then(()=>work(tx));tail=next.catch(()=>{});return next;}};
 return{db,row:()=>row,now:()=>at,advance:n=>at+=n,rebind:()=>row.policyRules.open_dot_employee.binding_revision++,revoke:()=>admin=false,checks:()=>checks};}
let f=fixture(),calls=0;
let result=await recoverBoundOpenDotLifecycles(f.db,{now:f.now,activate:async()=>{calls++;return{status:'pending'};}});
assert.equal(result.attempted,1);assert.equal(f.row().policyRules.open_dot_lifecycle_delivery.state,'pending');
await recoverBoundOpenDotLifecycles(f.db,{now:f.now,activate:async()=>{calls++;}});assert.equal(calls,1,'backoff prevents immediate repeat');
f.advance(2001);result=await recoverBoundOpenDotLifecycles(f.db,{now:f.now,activate:async(_principal,row)=>{calls++;return{status:'ready',employeeId:row.id};}});
assert.equal(result.delivered,1);assert.equal(f.row().persona,'saved');assert.equal(f.row().avatarUrl,'untouched');assert.deepEqual(f.row().policyRules.other,{preserve:true});
await recoverBoundOpenDotLifecycles(f.db,{now:f.now,activate:async()=>{calls++;}});assert.equal(calls,2,'delivered fingerprint not resent');
f=fixture();let enter,release;const entered=new Promise(resolve=>enter=resolve),blocked=new Promise(resolve=>release=resolve);
const first=recoverBoundOpenDotLifecycles(f.db,{now:f.now,activate:async(_principal,row)=>{enter();await blocked;return{status:'ready',employeeId:row.id};}});
await entered;result=await recoverBoundOpenDotLifecycles(f.db,{now:f.now,activate:async()=>{throw Error('double callback');}});assert.equal(result.attempted,0);
f.rebind();release();await first;assert.notEqual(f.row().policyRules.open_dot_lifecycle_delivery.state,'delivered','rebind invalidates old completion');
f=fixture();f.revoke();result=await recoverBoundOpenDotLifecycles(f.db,{now:f.now,activate:async()=>{throw Error('unauthorized');}});assert.equal(result.attempted,0);
f=fixture();result=await recoverBoundOpenDotLifecycles(f.db,{now:f.now,activate:async(_p,row)=>{f.advance(60001);return{status:'ready',employeeId:row.id};}});assert.equal(result.delivered,0,'expired producer cannot acknowledge claim');
f=fixture();result=await recoverBoundOpenDotLifecycles(f.db,{now:f.now,activate:async(_p,row)=>{f.revoke();return{status:'ready',employeeId:row.id};}});assert.equal(result.delivered,0,'revoked creator cannot acknowledge delivery');assert.equal(f.row().policyRules.open_dot_lifecycle_delivery.state,'pending');
for(const mutate of [r=>r.policyRules.open_dot_employee.execution_backend='native',r=>r.policyRules.open_dot_employee.binding_revision=0,r=>r.policyRules.native_lifecycle.creation_hash='malformed',r=>r.archivedAt=new Date(),r=>r.status='paused']){const row=employee();mutate(row);assert.equal(lifecycleDeliveryIdentity(row),null);}
console.log('PASS durable lifecycle recovery backoff, concurrent claim, binding CAS, expired producer, current membership and profile preservation');
