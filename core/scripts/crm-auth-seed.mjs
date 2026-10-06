/** Synthetic fixture admission for isolated actual Core/Control HTTP acceptance.
 * Never runs against a production database; no authentication bypass route is added.
 */
import {PrismaClient} from '@prisma/client';
import {writeFile} from 'node:fs/promises';
import {createPersistedApiKey} from '../src/auth/api-keys.js';
import {ControlPlaneSessionStore,buildSessionCookie,getRedisClient} from '../src/control-plane/session-store.js';
const url=new URL(process.env.DATABASE_URL??'');
if(url.hostname!=='crm-isolated-demo-20261006'||url.pathname!=='/crm_demo_full_auth'||process.env.CRM_AUTH_PREVIEW!=='synthetic-only') throw new Error('Refusing non-isolated CRM preview database');
const db=new PrismaClient();
const redisConfig={redisUrl:'redis://crm-redis-auth-preview-20261006:6379',sessionTtlSeconds:86400,authStateTtlSeconds:600};
const sessions=new ControlPlaneSessionStore(redisConfig);
const fixture={};
try {
 for(const n of ['1','2']) {
  const id=`10000000-0000-4000-8000-00000000000${n}`,userId=`20000000-0000-4000-8000-00000000000${n}`,email=`crm-preview-${n}@example.invalid`;
  await db.user.upsert({where:{id:userId},create:{id:userId,zitadelUserId:`crm-preview-${n}`,email,displayName:`CRM Preview ${n}`},update:{deletedAt:null}});
  await db.organization.upsert({where:{id},create:{id,zitadelOrgId:`crm-preview-${n}`,name:`CRM Preview ${n}`,slug:`crm-preview-${n}`},update:{}});
  await db.userOrganization.upsert({where:{userId_orgId:{userId,orgId:id}},create:{userId,orgId:id,role:'owner',roles:['org_owner'],isActive:true},update:{role:'owner',roles:['org_owner'],isActive:true}});
  const key=await createPersistedApiKey(db,{userId,orgId:id,name:'Synthetic CRM HTTP acceptance',scopes:['mcp'],expiresAt:new Date(Date.now()+86400000)});
  const sessionId=await sessions.createSession({userId,orgId:id,email});
  fixture[n]={orgId:id,userId,apiKey:key.rawKey,keyId:key.record.id,cookie:`hm_cp_session=${buildSessionCookie(process.env.HIVEMIND_CONTROL_PLANE_SESSION_SECRET || process.env.SESSION_SECRET,sessionId)}`};
 }
 const projectId='40000000-0000-4000-8000-000000000001';
 await db.project.upsert({where:{id:projectId},create:{id:projectId,orgId:fixture['1'].orgId,name:'Synthetic restricted project',slug:'restricted-project',createdBy:fixture['1'].userId},update:{}});
 const scoped=await createPersistedApiKey(db,{userId:fixture['1'].userId,orgId:fixture['1'].orgId,name:'Synthetic project restricted',scopes:['mcp'],projectId});
 const readOnly=await createPersistedApiKey(db,{userId:fixture['1'].userId,orgId:fixture['1'].orgId,name:'Synthetic unrelated scope',scopes:['memory:read']});
 fixture.projectApiKey=scoped.rawKey;fixture.unrelatedApiKey=readOnly.rawKey;fixture.projectId=projectId;
 fixture.runnerSecret=process.env.HIVE_HARNESS_RUNNER_SERVICE_SECRET;
 await writeFile('/tmp/crm-auth-preview-fixture.json',JSON.stringify(fixture,null,2),{mode:0o600});
 console.log('Created two synthetic organizations, persisted API keys, and native signed Redis sessions; private fixture file written.');
} finally {await db.$disconnect();(await getRedisClient(redisConfig))?.disconnect();}
