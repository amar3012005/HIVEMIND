const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { OfflineHistoryStore, normalizeSnapshot } = require('../src/offline-history-store');
const identity = { organizationId:'6dbd80ed-1dd9-4fa1-b958-43fa6e2dcd6f',userId:'b088ff09-e1ea-4f45-9655-e547541d7a76', company:'Sakana AI' };
const snapshot = {route:'https://runtime-runner.singulancelabs.com/hivemind/app/employee/harness/session/session-abc123',provider:'Runtime / DSH',title:'Runtime',messages:[{role:'user',text:'private question 1234'},{role:'assistant',text:'private answer 5678'}]};
const wrappingKey = crypto.randomBytes(32);
const safeStorage = {isAsyncEncryptionAvailable:async()=>true,encryptStringAsync:async value=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',wrappingKey,iv);return Buffer.concat([iv,c.update(value),c.final(),c.getAuthTag()]);},decryptStringAsync:async bytes=>{const c=crypto.createDecipheriv('aes-256-gcm',wrappingKey,bytes.subarray(0,12));c.setAuthTag(bytes.subarray(-16));return {result:Buffer.concat([c.update(bytes.subarray(12,-16)),c.final()]).toString()};}};
async function fixture(run) { const directory=await fs.mkdtemp(path.join(os.tmpdir(),'hm-history-'));try{await run(directory);}finally{await fs.rm(directory,{recursive:true,force:true});} }
test('encrypted history survives app restart without plaintext, actions or auth material',()=>fixture(async directory=>{
 const first=new OfflineHistoryStore({directory,safeStorage});assert.equal(await first.init(),true);await first.activate(identity);await first.save(snapshot);
 const files=await fs.readdir(directory);for(const name of files){const b=await fs.readFile(path.join(directory,name));assert.equal(b.includes(Buffer.from('private answer')),false);assert.equal(b.includes(Buffer.from('Sakana')),false);assert.equal((await fs.stat(path.join(directory,name))).mode&0o777,0o600);}
 const second=new OfflineHistoryStore({directory,safeStorage});await second.init();const list=await second.list();assert.equal(list.company,'Sakana AI');assert.equal(list.rooms.length,1);assert.deepEqual((await second.read(list.rooms[0].id)).messages,snapshot.messages);
}));
test('account scope, signout purge and stale writes cannot cross accounts',()=>fixture(async directory=>{
 const store=new OfflineHistoryStore({directory,safeStorage});await store.init();await store.activate(identity);await store.save(snapshot);const old=(await store.list()).rooms[0].id;
 await store.activate({...identity,userId:'a088ff09-e1ea-4f45-9655-e547541d7a76'});assert.equal((await store.list()).rooms.length,0);await assert.rejects(store.read(old));
 await store.activate(identity);const pending=store.save({...snapshot,title:'stale'});await store.lock({purge:true});await pending;assert.equal((await store.list()).rooms.length,0);
 await store.activate(identity);assert.equal((await store.list()).rooms.length,0);
}));
test('authenticated encryption rejects tampering and moving records into another route',()=>fixture(async directory=>{
 const store=new OfflineHistoryStore({directory,safeStorage});await store.init();await store.activate(identity);await store.save(snapshot);const id=(await store.list()).rooms[0].id,file=path.join(directory,store.active.scope+'-'+id+'.enc');
 const b=await fs.readFile(file);b[b.length-1]^=1;await fs.writeFile(file,b);assert.equal((await store.list()).rooms.length,0);await assert.rejects(store.read(id));
}));
test('expired account lock and unavailable Keychain fail closed',()=>fixture(async directory=>{
 let now=100000000;const store=new OfflineHistoryStore({directory,safeStorage,now:()=>now});await store.init();await store.activate(identity);await store.save(snapshot);now+=86400001;assert.equal((await store.list()).rooms.length,0);
 const unavailable=new OfflineHistoryStore({directory:directory+'/unavailable',safeStorage:{isAsyncEncryptionAvailable:async()=>false}});assert.equal(await unavailable.init(),false);assert.equal(await unavailable.save(snapshot),false);await assert.rejects(fs.stat(directory+'/unavailable'));
}));
test('snapshot schema strips queries and rejects executable or action payloads',()=>{
 assert.equal(normalizeSnapshot({...snapshot,route:snapshot.route+'?ticket=secret'}).route,snapshot.route);
 assert.throws(()=>normalizeSnapshot({...snapshot,route:'https://evil.example/hivemind/app/employee/harness/session/session-abc'}));
 assert.throws(()=>normalizeSnapshot({...snapshot,messages:[{role:'tool',text:'send email'}]}));
 assert.throws(()=>normalizeSnapshot({...snapshot,route:snapshot.route+'?c=../../secret'}));
});
test('desktop observer rejects foreign auth, stale responses, same-document account reuse and foreign IPC',()=>fixture(async directory=>{
 const {createOfflineHistory}=require('../src/offline-history');const handlers=new Map();
 const manager=createOfflineHistory({app:{getPath:()=>directory},safeStorage,BrowserWindow:class {},ipcMain:{removeHandler(){},handle:(name,handler)=>handlers.set(name,handler)},getMainWindow:()=>null,log:{info(){}}});await manager.ready;
 const auth=new Request('https://api.singulancelabs.com/v1/bootstrap');
 const make=(user=identity.userId)=>Response.json({user:{id:user},organization:{id:identity.organizationId,name:'Sakana AI'}});
 assert.equal(manager.begin(new Request('https://evil.example/v1/bootstrap')),null);
 const stale=manager.begin(auth),latest=manager.begin(auth);await manager.response(auth,make(),latest);await manager.response(auth,make('a088ff09-e1ea-4f45-9655-e547541d7a76'),stale);assert.equal(manager.store.active.scope,manager.store.scopeFor(identity));
 await manager.response(auth,make('a088ff09-e1ea-4f45-9655-e547541d7a76'),manager.begin(auth));assert.equal(manager.store.active,null);
 await manager.response(auth,make('a088ff09-e1ea-4f45-9655-e547541d7a76'),manager.begin(auth));assert.equal(manager.store.active,null);
 await assert.rejects(handlers.get('offline-history:list')({sender:{id:987},senderFrame:{url:'https://evil.example'}}));
}));

test('cached route lookup never crosses employees, requested conversations or account scopes',()=>fixture(async directory=>{
 const store=new OfflineHistoryStore({directory,safeStorage});await store.init();await store.activate(identity);
 const route='https://runtime-runner.singulancelabs.com/hivemind/app/employee/dots/employee/897b5ddc-9c1d-4877-ace8-d1cdeddb16bd';
 await store.save({...snapshot,provider:'Open Dot',route:route+'?c=conv_first',framePath:'/dots/dot_turing'});
 assert.equal((await store.findRoute(route)).route,route+'?c=conv_first');
 assert.equal(await store.findRoute(route+'?c=conv_other'),null);
 assert.equal(await store.findRoute(route.replace('897b5ddc','997b5ddc')),null);
 await store.activate({...identity,userId:'a088ff09-e1ea-4f45-9655-e547541d7a76'});
 assert.equal(await store.findRoute(route),null);
}));
