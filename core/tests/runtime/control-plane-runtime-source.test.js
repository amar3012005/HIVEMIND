import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const controlPlaneServer = path.join(repoRoot, 'core/src/control-plane-server.js');

function readControlPlane() {
  return fs.readFileSync(controlPlaneServer, 'utf8');
}

test('control-plane gates recurring schedulers behind runtime role checks', () => {
  const text = readControlPlane();
  assert.match(text, /if \(prisma && shouldRunRecurringMaintenanceJobs\(\)\) \{/);
  assert.match(text, /if \(prisma && HYPER_CYCLE_ENABLED && shouldRunRecurringMaintenanceJobs\(\)\) \{/);
  assert.match(text, /const HYPER_CYCLE_START_EMAIL_ENABLED = String\(process\.env\.HYPER_CYCLE_START_EMAIL_ENABLED \|\| 'false'\)/);
  assert.match(text, /if \(HYPER_CYCLE_START_EMAIL_ENABLED\) \{/);
  assert.match(text, /if \(shouldStartHttpServer\(\)\) \{/);
});

test('workspace notifications include exact Runtime attention with lifecycle and preserve user scope', () => {
  const text = readControlPlane();
  assert.match(text, /type: \{ startsWith: 'lifecycle\.' \}/);
  assert.match(text, /const lifecycleWhere = \{ orgId: current\.session\.orgId, userId: current\.session\.userId, OR: \[/);
  assert.match(text, /\{ type: 'runtime\.attention' \}/);
});

test('control-plane routes hyper room-turn dispatches through shared helper', () => {
  const text = readControlPlane();
  assert.match(text, /function dispatchHyperRoomTurn\(body\)/);
  assert.equal(text.includes("fetch(`${sidecarBase}/internal/hyper/room-turn`"), false);
  assert.equal(text.includes("fetch(`${process.env.EMPLOYEES_SIDECAR_URL || 'http://hm-employees:8060'}/internal/hyper/room-turn`"), false);
});

test('control-plane has no hard-coded internal master-key fallback', () => {
  const text = readControlPlane();
  assert.equal(text.includes('hm_master_key_99228811'), false);
  assert.match(text, /getInternalApiKey/);
});

test('real notification route includes attention in items/unread and denies unauthenticated or inactive scope', async () => {
  const source=readControlPlane(),start=source.indexOf("  if (pathname === '/v1/workspace/notifications' && req.method === 'GET') {");
  const end=source.indexOf('\n  // Explicit per-user consent',start);
  assert.ok(start>0&&end>start);
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const route=new AsyncFunction('pathname','req','res','url','prisma','requireSession','getActiveOrganizationMembership','jsonResponse',source.slice(start,end));
  const rows=[
    {id:'attention',orgId:'org',userId:'user',type:'runtime.attention',readAt:null},
    {id:'lifecycle',orgId:'org',userId:'user',type:'lifecycle.email.sent',readAt:null},
    {id:'read',orgId:'org',userId:'user',type:'runtime.attention',readAt:new Date()},
    {id:'generic',orgId:'org',userId:'user',type:'workspace.update',readAt:null},
    {id:'foreign-user',orgId:'org',userId:'other',type:'runtime.attention',readAt:null},
    {id:'foreign-org',orgId:'other',userId:'user',type:'runtime.attention',readAt:null},
  ];
  const matches=(row,where)=>Object.entries(where).every(([key,value])=>key==='OR'?value.some(clause=>matches(row,clause)):typeof value==='object'&&value!==null?typeof row[key]==='string'&&row[key].startsWith(value.startsWith):row[key]===value);
  let reads=0,result;
  const prisma={workspaceNotification:{findMany:async({where,take})=>{reads++;return rows.filter(row=>matches(row,where)).slice(0,take)},count:async({where})=>{reads++;return rows.filter(row=>matches(row,where)).length}}};
  const run=(session=true,membership=true,unread=false)=>route('/v1/workspace/notifications',{method:'GET'},{},new URL('http://fixture/v1/workspace/notifications'+(unread?'?unread=true':'')),prisma,async()=>session?{session:{orgId:'org',userId:'user'}}:null,async()=>membership,(_res,data,status=200)=>{result={status,...data};return result});
  await run();assert.deepEqual(result.items.map(row=>row.id),['attention','lifecycle','read']);assert.equal(result.unread,2);
  await run(true,true,true);assert.deepEqual(result.items.map(row=>row.id),['attention','lifecycle']);assert.equal(result.unread,2);
  const before=reads;await run(false);assert.equal(reads,before);await run(true,false);assert.equal(reads,before);assert.equal(result.status,404);
});
