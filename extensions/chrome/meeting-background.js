/* Meeting detection works without an open HIVEMIND tab; capture is user initiated. */
chrome.runtime.onInstalled.addListener(async()=>{
 const cfg=await chrome.storage.local.get(['apiBase','controlPlaneBase']);
 const patch={};if(!cfg.apiBase||cfg.apiBase.includes('davinciai.eu'))patch.apiBase=HMMeeting.CORE;
 if(!cfg.controlPlaneBase||cfg.controlPlaneBase.includes('davinciai.eu'))patch.controlPlaneBase=HMMeeting.CONTROL;
 if(Object.keys(patch).length)await chrome.storage.local.set(patch);
 chrome.alarms.create('hm-extension-update',{periodInMinutes:360});
});
async function openMeetingRecorder(tabId){
 const tab=await chrome.tabs.get(Number(tabId));
 const url=new URL(chrome.runtime.getURL('meeting-recorder.html'));
 if(tab?.id)url.searchParams.set('tabId',String(tab.id));
 const windows=await chrome.windows.getAll({populate:true});
 const existing=windows.find(w=>w.tabs?.some(t=>t.url?.startsWith(chrome.runtime.getURL('meeting-recorder.html'))));
 if(existing)return chrome.windows.update(existing.id,{focused:true});
 return chrome.windows.create({url:url.href,type:'popup',width:510,height:760,focused:true});
}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
 if(m.action==='hm-meeting-detected'){
  if(!sender.tab||!HMMeeting.detect(sender.tab.url))return;
  chrome.action.setBadgeText({tabId:sender.tab.id,text:'Meet'});
  chrome.action.setBadgeBackgroundColor({tabId:sender.tab.id,color:'#166b58'});
  const id='hm-meeting-'+sender.tab.id;const key=id+':'+HMMeeting.detect(sender.tab.url).url;
  chrome.storage.session.get(key).then(async seen=>{if(seen[key])return;await chrome.storage.session.set({[key]:true});
   await chrome.notifications.create(id,{type:'basic',iconUrl:'icons/icon128.png',title:'HIVEMIND · Meeting detected',message:'Open your private meeting companion to record notes and get live assistance.',buttons:[{title:'Open companion'}]});
  }).catch(()=>{});return;
 }
 if(m.action==='hm-meeting-open'){
  const trusted=sender.url?.startsWith(chrome.runtime.getURL(''));
  if(!trusted&&!HMMeeting.detect(sender.tab?.url))return;
  openMeetingRecorder(sender.tab?.id||m.tabId).then(()=>reply({ok:true})).catch(e=>reply({error:e.message}));return true;
 }
});
chrome.notifications.onClicked.addListener(id=>{if(id.startsWith('hm-meeting-'))openMeetingRecorder(Number(id.slice(11))).catch(()=>{});});
chrome.notifications.onButtonClicked.addListener((id,index)=>{if(index===0&&id.startsWith('hm-meeting-'))openMeetingRecorder(Number(id.slice(11))).catch(()=>{});});

async function checkExtensionUpdate(){try{
 const r=await fetch(HMMeeting.CORE+'/install/chrome-extension.json',{cache:'no-store',signal:AbortSignal.timeout(10000)});if(!r.ok)return;const latest=await r.json();
 const version=chrome.runtime.getManifest().version;
 if(!/^\d+(\.\d+){2,3}$/.test(latest.version||''))return;
 const a=latest.version.split('.').map(Number),b=version.split('.').map(Number);let newer=false;for(let i=0;i<Math.max(a.length,b.length);i++){if((a[i]||0)!==(b[i]||0)){newer=(a[i]||0)>(b[i]||0);break;}}
 if(newer)await chrome.notifications.create('hm-extension-update',{type:'basic',iconUrl:'icons/icon128.png',title:'HIVEMIND update available',message:'A new extension version is ready. Finish your recording before updating.'});
}catch{}}
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='hm-extension-update')checkExtensionUpdate()});
chrome.runtime.onStartup.addListener(()=>{chrome.alarms.create('hm-extension-update',{periodInMinutes:360});checkExtensionUpdate()});
chrome.notifications.onClicked.addListener(id=>{if(id==='hm-extension-update')chrome.tabs.create({url:HMMeeting.CORE+'/install/chrome-extension.zip'})});
