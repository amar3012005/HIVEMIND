const{app,session,BrowserWindow}=require('electron');const path=require('path'),fs=require('fs');
const output=process.env.SINGULANCE_BUNDLE_EVIDENCE;if(!output||!path.isAbsolute(output))throw Error('Absolute evidence output required');
app.setPath('userData',path.join(path.dirname(output),'isolated-electron-profile'));
app.whenReady().then(async()=>{try{
 const{installBundledFrontends,nativeCombo}=require('../src/bundled-frontends');
 const bundle=installBundledFrontends(session.defaultSession,path.resolve(__dirname,'../assets/frontend'));
 let blockedApiRequests=0;
 session.defaultSession.webRequest.onBeforeRequest((details,done)=>{ if(new URL(details.url).pathname.startsWith('/api/')) {blockedApiRequests++;done({cancel:true});} else done({}); });
 session.defaultSession.enableNetworkEmulation({offline:true});
 const keys=Object.keys(bundle.manifest.assets);const samples=[['outer',keys.find(k=>k.startsWith('app:/static/js/'))],['opendot',keys.find(k=>k.startsWith('dot:')&&k.endsWith('.js'))]];
 const results=[];
 for(const[kind,key]of samples){if(!key)throw Error('Missing '+kind);const url='https://'+(kind==='opendot'?'dots.singulancelabs.com':'runtime-runner.singulancelabs.com')+key.slice(key.indexOf(':')+1);const response=await session.defaultSession.fetch(url);results.push({kind,status:response.status,source:response.headers.get('x-singulance-frontend'),bytes:(await response.arrayBuffer()).byteLength});}
 const ids=Object.keys(bundle.manifest.plugins).slice(0,3);const combo=nativeCombo(bundle.manifest.plugins,ids);const response=await session.defaultSession.fetch('https://runtime-runner.singulancelabs.com/plugins/??'+ids.map(id=>id+'/client.js').join(',')+'&rev='+combo.rev);results.push({kind:'native-dsh',status:response.status,source:response.headers.get('x-singulance-frontend'),bytes:(await response.arrayBuffer()).byteLength});
 for (const [host, records] of Object.entries(bundle.manifest.pluginsByHost || {})) {
 const ids=Object.keys(records);const combo=nativeCombo(records,ids);
 const reply=await session.defaultSession.fetch('https://'+host+'/plugins/??'+ids.map(id=>id+'/client.js').join(',')+'&rev='+combo.rev);
 results.push({kind:host,status:reply.status,source:reply.headers.get('x-singulance-frontend'),bytes:(await reply.arrayBuffer()).byteLength,plugins:ids.length});
 }
 const index=await session.defaultSession.fetch('https://runtime-runner.singulancelabs.com/hivemind/app/employee/harness',{headers:{accept:'text/html'}});results.push({kind:'document',status:index.status,source:index.headers.get('x-singulance-frontend'),csp:!!index.headers.get('content-security-policy')});
 if(results.filter(r=>r.kind!=='native-redirect').some(r=>r.status!==200||r.source!=='bundled'))throw Error('Packaged frontend was not used');
 if(bundle.manifest.dotDocument) {
  const url='https://dots.singulancelabs.com/dots/desktop-offline-proof?embed=hivemind';
  const document=await session.defaultSession.fetch(url,{headers:{accept:'text/html'}});
  if(document.headers.get('x-singulance-frontend')!=='bundled')throw Error('Remote employee document');
  const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,sandbox:true}});
  await win.loadURL(url);
  const until=Date.now()+15000;let visible='';
  do {visible=await win.webContents.executeJavaScript('document.body.innerText');if(/Retry/.test(visible))break;await new Promise(r=>setTimeout(r,100));} while(Date.now()<until);
  if(!/Retry/.test(visible))throw Error('Desktop client did not hydrate and attempt authenticated admission offline: '+visible.slice(0,200));
  results.push({kind:'opendot-first-document-offline',status:document.status,source:'bundled',rendered:true,blockedApiRequests});
  if(!blockedApiRequests)throw Error('Offline admission attempt was not blocked by network guard');
  fs.writeFileSync(path.join(path.dirname(output),'offline-entry.png'),(await win.webContents.capturePage()).toPNG());
  win.destroy();
 }
 fs.writeFileSync(output,JSON.stringify({release:bundle.manifest.release,results},null,2));app.exit(0);
}catch(error){console.error(error);app.exit(1);}});
