const { app, session, BrowserWindow, ipcMain, safeStorage } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path');
const output = process.env.SINGULANCE_HISTORY_EVIDENCE;
if (!output || !path.isAbsolute(output)) throw Error('Absolute evidence output required');
app.setPath('userData', path.join(path.dirname(output), 'isolated-history-profile-'+process.pid));
app.whenReady().then(async () => {
  let main;
  try {
    const { createOfflineHistory } = require('../src/offline-history');
    const { OfflineHistoryStore } = require('../src/offline-history-store');
    const manager = createOfflineHistory({ app, safeStorage, BrowserWindow, ipcMain, getMainWindow: () => main, log: { info() {} } });
    if (!await manager.ready) throw Error('Keychain encryption unavailable');
    let networkRequests = 0;
    session.defaultSession.protocol.handle('https', request => {
      if (new URL(request.url).hostname === 'runtime-runner.singulancelabs.com') return new Response('<!doctype html><title>Runtime offline fixture</title><div data-chat-flow-kind="user">Keep the frontier plan.</div><div data-chat-flow-kind="assistant-step">Offline canary: the saved frontier plan is ready.</div>', { headers: { 'content-type':'text/html' } });
      if(new URL(request.url).hostname==='dots.singulancelabs.com') return new Response('<!doctype html><title>Loading specialist</title>', {headers:{'content-type':'text/html'}});
      networkRequests++; return new Response(null, {status:503});
    });
    main = new BrowserWindow({ show:false, webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true} }); manager.attach(main);
    await main.loadURL('https://runtime-runner.singulancelabs.com/hivemind/app/employee/harness/session/session-cachecanary');
    const auth = new Request('https://api.singulancelabs.com/v1/bootstrap');
    await manager.response(auth, Response.json({user:{id:'a088ff09-e1ea-4f45-9655-e547541d7a76'},organization:{id:'adbd80ed-1dd9-4fa1-b958-43fa6e2dcd6f',name:'Offline cache fixture'}}),manager.begin(auth));
    await manager.capture(); const initial = await manager.store.list(); if(initial.rooms.length!==1) throw Error('Native rendered history not captured');
    const directory = path.join(app.getPath('userData'),'offline-history-v1');
    let containsPlaintext = false; for (const file of await fs.readdir(directory)) if ((await fs.readFile(path.join(directory,file))).includes(Buffer.from('saved frontier plan'))) containsPlaintext=true;
    if(containsPlaintext) throw Error('Plaintext history found');
    const reopened = new OfflineHistoryStore({directory,safeStorage}); await reopened.init(); const list = await reopened.list();
    if(list.rooms.length!==1 || !(await reopened.read(list.rooms[0].id)).messages.some(row=>row.text.includes('saved frontier plan'))) throw Error('Encrypted restart recovery failed');
    // The same encrypted transcript appears in the regular chat area while
    // native loading is pending, then yields to the live owner.
    await manager.store.save({route:'https://runtime-runner.singulancelabs.com/hivemind/app/employee/harness/session/session-cachecanary',provider:'Runtime / DSH',title:'Runtime',messages:Array.from({length:95},(_,i)=>({role:i%2?'assistant':'user',text:'Cached message '+i}))});
    await main.webContents.executeJavaScript(`document.body.innerHTML='<div data-native-chat="true" data-phase="settling" style="height:600px"><div data-conversation-scroll style="height:550px"></div></div>'`);
    await manager.preview();
    const cachedFirst=await main.webContents.executeJavaScript(`(()=>{const h=document.querySelector('[data-desktop-cached-chat]');if(!h)return null;const s=h.shadowRoot;const initial=s.querySelectorAll('article').length;s.querySelector('.older').click();return {initial,older:s.querySelectorAll('article').length,hasComposer:!!s.querySelector('textarea'),text:s.textContent.includes('Cached message 94')};})()`);
    if(!cachedFirst || cachedFirst.initial!==30 || cachedFirst.older!==60 || cachedFirst.hasComposer || !cachedFirst.text)throw Error('Cached-first progressive presentation failed');
    await main.webContents.executeJavaScript(`document.querySelector('[data-native-chat]').dataset.phase='active'`);await manager.preview();
    if(await main.webContents.executeJavaScript(`!!document.querySelector('[data-desktop-cached-chat]')`))throw Error('Cache did not yield to native chat');
    const dotRoute='https://runtime-runner.singulancelabs.com/hivemind/app/employee/dots/employee/897b5ddc-9c1d-4877-ace8-d1cdeddb16bd?c=conv_fixture';
    await main.loadURL(dotRoute);
    await manager.response(auth,Response.json({user:{id:'a088ff09-e1ea-4f45-9655-e547541d7a76'},organization:{id:'adbd80ed-1dd9-4fa1-b958-43fa6e2dcd6f',name:'Offline cache fixture'}}),manager.begin(auth));
    await manager.store.save({route:dotRoute,provider:'Open Dot',framePath:'/dots/dot_fixture',title:'Specialist',messages:[{role:'assistant',text:'Saved specialist response'}]});
    await main.webContents.executeJavaScript(`document.body.innerHTML='<iframe style="width:800px;height:600px" src="https://dots.singulancelabs.com/dots/dot_fixture?c=conv_fixture"></iframe>'`);
    await manager.preview();
    const dotCached=await main.webContents.executeJavaScript(`document.querySelector('[data-desktop-cached-chat]')?.shadowRoot.textContent.includes('Saved specialist response')`);
    if(!dotCached)throw Error('Open Dot saved transcript did not render');
    await fs.writeFile(path.join(path.dirname(output),'cached-first-fixture.png'),(await main.webContents.capturePage()).toPNG());
    const child=main.webContents.mainFrame.framesInSubtree.find(f=>f.url.startsWith('https://dots.singulancelabs.com/dots/dot_fixture'));
    if(child){await child.executeJavaScript(`document.body.innerHTML='<div data-chat-conversation="conv_fixture">Live specialist response</div>'`);await manager.preview();if(await main.webContents.executeJavaScript(`!!document.querySelector('[data-desktop-cached-chat]')`))throw Error('Open Dot cache did not yield to native view');}

    await main.webContents.executeJavaScript(`history.replaceState(null,'','/hivemind/app/employee/dots/employee/997b5ddc-9c1d-4877-ace8-d1cdeddb16bd')`);
    await new Promise(r=>setTimeout(r,160));
    if(await main.webContents.executeJavaScript(`!!document.querySelector('[data-desktop-cached-chat]')`))throw Error('Previous employee transcript survived navigation');
    // Restore the offline viewer assertion fixture.
    await manager.store.save({route:'https://runtime-runner.singulancelabs.com/hivemind/app/employee/harness/session/session-cachecanary',provider:'Runtime / DSH',title:'Runtime',messages:[{role:'assistant',text:'Offline canary: the saved frontier plan is ready.'}]});
    session.defaultSession.enableNetworkEmulation({offline:true});
    await manager.show(); const viewer=BrowserWindow.getAllWindows().find(window=>window!==main);
    await viewer.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const tick=()=>{const button=document.querySelector('nav button');if(button){button.click();resolve(true);}else if(++n<50)setTimeout(tick,50);else reject(Error('No offline room'));};tick();})`);
    const rendered=await viewer.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const tick=()=>{const text=document.querySelector('article').innerText;if(text.includes('saved frontier plan'))resolve({readonly:text.includes('Read-only copy'),hasComposer:!!document.querySelector('textarea,[contenteditable=true]'),hasImages:!!document.querySelector('article img')});else if(++n<50)setTimeout(tick,50);else reject(Error('Cached messages did not render'));};tick();})`);
    if(!rendered.readonly||rendered.hasComposer||rendered.hasImages||networkRequests)throw Error('Offline viewer is not isolated and read-only');
    await fs.writeFile(output,JSON.stringify({fixture:true,cachedFirst,dotCached,keychain:true,encryptedAtRest:!containsPlaintext,reopenedAfterStoreRestart:true,networkOffline:true,offlineViewer:rendered,networkRequests,rooms:list.rooms.length},null,2));
    app.exit(0);
  } catch(error) { console.error(error); app.exit(1); }
});
