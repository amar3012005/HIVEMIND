const{app,session}=require('electron');const path=require('path'),fs=require('fs');
const output=process.env.SINGULANCE_BUNDLE_EVIDENCE;if(!output||!path.isAbsolute(output))throw Error('Absolute evidence output required');
app.setPath('userData',path.join(path.dirname(output),'isolated-electron-profile'));
app.whenReady().then(async()=>{try{
 const{installBundledFrontends,nativeCombo}=require('../src/bundled-frontends');
 const bundle=installBundledFrontends(session.defaultSession,path.resolve(__dirname,'../assets/frontend'));
 const keys=Object.keys(bundle.manifest.assets);const samples=[['outer',keys.find(k=>k.startsWith('app:/static/js/'))],['opendot',keys.find(k=>k.startsWith('dot:')&&k.endsWith('.js'))]];
 const results=[];
 for(const[kind,key]of samples){if(!key)throw Error('Missing '+kind);const url='https://'+(kind==='opendot'?'dots.singulancelabs.com':'runtime-runner.singulancelabs.com')+key.slice(key.indexOf(':')+1);const response=await session.defaultSession.fetch(url);results.push({kind,status:response.status,source:response.headers.get('x-singulance-frontend'),bytes:(await response.arrayBuffer()).byteLength});}
 const redirect=await session.defaultSession.fetch('https://dots.singulancelabs.com/apps/'); if(redirect.status!==401)throw Error('Browser redirect failed: '+redirect.status); results.push({kind:'native-redirect',status:redirect.status,bytes:(await redirect.arrayBuffer()).byteLength});
 const ids=Object.keys(bundle.manifest.plugins).slice(0,3);const combo=nativeCombo(bundle.manifest.plugins,ids);const response=await session.defaultSession.fetch('https://runtime-runner.singulancelabs.com/plugins/??'+ids.map(id=>id+'/client.js').join(',')+'&rev='+combo.rev);results.push({kind:'native-dsh',status:response.status,source:response.headers.get('x-singulance-frontend'),bytes:(await response.arrayBuffer()).byteLength});
 const index=await session.defaultSession.fetch('https://runtime-runner.singulancelabs.com/hivemind/app/employee/harness',{headers:{accept:'text/html'}});results.push({kind:'document',status:index.status,source:index.headers.get('x-singulance-frontend'),csp:!!index.headers.get('content-security-policy')});
 if(results.filter(r=>r.kind!=='native-redirect').some(r=>r.status!==200||r.source!=='bundled'))throw Error('Packaged frontend was not used');
 fs.writeFileSync(output,JSON.stringify({release:bundle.manifest.release,results},null,2));app.exit(0);
}catch(error){console.error(error);app.exit(1);}});
