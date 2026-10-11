import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=fs.readFileSync(new URL('../../src/control-plane-server.js',import.meta.url),'utf8');
const section=source.slice(source.indexOf('async function resolveCurrentOrg('),source.indexOf('async function upsertUserFromZitadel('));
function resolvers(membership) {
 const queries=[];
 const prisma={userOrganization:{findFirst:async q=>{queries.push(q);return membership;},findUnique:async q=>{queries.push(q);return membership;}}};
 const scope=vm.createContext({prisma,isCanonicalUuid:x=>x==='authorized-user'||x==='authorized-org'});
 vm.runInContext(section,scope);
 return {scope,queries};
}
for(const name of ['resolveCurrentOrg','resolveSessionOrg']) {
 test(`${name} puts undated test memberships behind joined memberships`,async()=>{
  const {scope,queries}=resolvers({org:{id:'authorized-org'},orgId:'authorized-org',role:'member'});
  await scope[name]('authorized-user');
  const q=JSON.parse(JSON.stringify(queries[0]));
  assert.deepEqual(q.where,{userId:'authorized-user',isActive:true});
  assert.deepEqual(q.orderBy,[{joinedAt:{sort:'desc',nulls:'last'}},{invitedAt:{sort:'desc',nulls:'last'}}]);
 });
 test(`${name} rejects invalid identity without a membership lookup`,async()=>{
  const {scope,queries}=resolvers(null);
  assert.equal((await scope[name]('invalid')).org,null);assert.equal(queries.length,0);
 });
 test(`${name} returns no organization without active membership`,async()=>{
  const {scope}=resolvers(null);assert.equal((await scope[name]('authorized-user')).org,null);
 });
}
test('an explicitly selected active workspace keeps priority',async()=>{
 const {scope,queries}=resolvers({isActive:true,org:{id:'authorized-org'},role:'owner'});
 assert.equal((await scope.resolveCurrentOrg('authorized-user','authorized-org')).org.id,'authorized-org');
 assert.equal(queries.length,1);assert.ok(queries[0].where.userId_orgId);
});
