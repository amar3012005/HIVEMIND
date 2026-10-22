const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const args=Object.fromEntries(process.argv.slice(2).map(value=>{const i=value.indexOf('=');return [value.slice(0,i),value.slice(i+1)];}));
for(const key of ['outer','dot','native','brain','shell','brainShell'])if(!args[key]||!path.isAbsolute(args[key]))throw Error('Pass absolute '+key+'= directory/file');
const root=path.resolve(__dirname,'../assets/frontend');fs.mkdirSync(root,{recursive:true});
const manifest={version:1,release:{outer:args.outerRevision,runtime:args.runtimeRevision,brain:args.brainRevision,dot:args.dotRevision},assets:{},plugins:JSON.parse(fs.readFileSync(args.native,'utf8')).plugins};
manifest.pluginsByHost = {'runtime-runner.singulancelabs.com':manifest.plugins,'next.singulancelabs.com':JSON.parse(fs.readFileSync(args.brain,'utf8')).plugins};
const mime={'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.map':'application/json','.html':'text/html; charset=utf-8','.woff2':'font/woff2','.woff':'font/woff','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8'};
function add(file){const body=fs.readFileSync(file);const hash=crypto.createHash('sha256').update(body).digest('hex');const target='files/'+hash+path.extname(file);fs.mkdirSync(path.join(root,'files'),{recursive:true});fs.writeFileSync(path.join(root,target),body);return {file:target,sha256:hash,type:mime[path.extname(file)]||'application/octet-stream'};}
function tree(directory,kind,prefix=''){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name),url=prefix+'/'+entry.name;if(entry.isDirectory())tree(file,kind,url);else if(entry.isFile()&&entry.name!=='index.html'&&entry.name!=='sw.js'&&entry.name!=='harness-shell.js'&&entry.name!=='harness-shell.js.map')manifest.assets[kind+':'+url]=add(file);}}
if(args.dotPublic) tree(args.dotPublic,'dot');
tree(args.outer,'app');tree(args.dot,'dot','/_next/static');tree(args.shell,'app','/assets');
tree(args.brainShell,'brain','/assets');
if(args.dotDocument) {
 const html=fs.readFileSync(args.dotDocument,'utf8').replace('<html','<html data-opendot-desktop="1"');
 const file=path.join(root,'desktop-entry.html');fs.writeFileSync(file,html);manifest.dotDocument=add(file);
 manifest.dotDocument.headers={'content-security-policy':"frame-ancestors 'self' https://next.singulancelabs.com https://runtime-runner.singulancelabs.com"};
}
manifest.index=add(path.join(args.outer,'index.html'));
const shell=path.join(args.shell,'harness-shell.js');manifest.nativeShell=add(shell);manifest.nativeShell.rev=crypto.createHash('sha1').update(fs.readFileSync(shell)).digest('hex').slice(0,12);
manifest.shellsByHost={'runtime-runner.singulancelabs.com':manifest.nativeShell,'next.singulancelabs.com':add(path.join(args.brainShell,'harness-shell.js'))};
(async()=>{const response=await fetch('https://next.singulancelabs.com/hivemind/app/overview/new');if(!response.ok)throw Error('Cannot verify current security headers');manifest.index.headers={};for(const name of ['content-security-policy','x-content-type-options','referrer-policy','permissions-policy','cross-origin-opener-policy','cross-origin-resource-policy']){const value=response.headers.get(name);if(value)manifest.index.headers[name]=value;}
fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest));console.log(JSON.stringify({assets:Object.keys(manifest.assets).length,plugins:Object.keys(manifest.plugins).length,release:manifest.release}));})();
