const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'..');const context={URL};vm.runInNewContext(fs.readFileSync(path.join(root,'meeting-common.js'),'utf8'),context);const {detect,apiOrigin}=context.HMMeeting;
test('supported meeting URLs are identified and credentials/query strings excluded',()=>{
 for(const url of ['https://meet.google.com/abc-defg-hij?authuser=1','https://teams.microsoft.com/l/meetup-join/abc','https://us02web.zoom.us/wc/join/123?pwd=secret','https://company.webex.com/meet/person','https://meet.jit.si/our-room']){const d=detect(url);assert.ok(d,url);assert.ok(!d.url.includes('?'))}
});
test('lookalike domains, HTTP pages and non-meeting Google routes do not activate',()=>{
 for(const url of ['https://meet.google.com.evil.test/abc-defg-hij','https://evilzoom.us/wc/join/123','http://meet.google.com/abc-defg-hij','https://meet.google.com/','https://accounts.google.com/signin','javascript:alert(1)'])assert.equal(detect(url),null,url);
});
test('legacy configuration moves to the current API without changing a custom tenant endpoint',()=>{assert.equal(apiOrigin('https://core.hivemind.davinciai.eu:8050'),'https://core.singulancelabs.com');assert.equal(apiOrigin('https://tenant.example.test/api'),'https://tenant.example.test')});
test('manifest includes detection scripts and only local extension resources',()=>{
 const m=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')));assert.equal(m.manifest_version,3);assert.equal(m.version,'2.3.0');assert.ok(m.permissions.includes('notifications'));for(const c of m.content_scripts)for(const f of c.js)assert.ok(fs.existsSync(path.join(root,f)));assert.ok(m.host_permissions.every(v=>!v.includes('davinciai.eu')));
});
