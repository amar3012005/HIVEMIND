/* Shared exact-host matching; meeting pages never receive account credentials. */
(function(root){
 const providers=[
  ['Google Meet',h=>h==='meet.google.com',p=>/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:\/|$)/i.test(p)],
  ['Microsoft Teams',h=>['teams.microsoft.com','teams.live.com','teams.cloud.microsoft'].includes(h),p=>/\/meet|\/l\/meetup-join|\/v2/i.test(p)],
  ['Zoom',h=>h==='zoom.us'||h.endsWith('.zoom.us'),p=>/\/wc\/|\/j\//.test(p)],
  ['Webex',h=>h==='webex.com'||h.endsWith('.webex.com'),p=>/\/meet\/|\/join|\/webappng\/|\/wbxmjs\//i.test(p)],
  ['Jitsi',h=>h==='meet.jit.si',p=>p.length>1],
 ];
 function detect(url){try{const u=new URL(url);if(u.protocol!=='https:')return null;const v=providers.find(x=>x[1](u.hostname)&&x[2](u.pathname));return v?{provider:v[0],url:u.origin+u.pathname}:null}catch{return null}}
 function apiOrigin(value){try{const u=new URL(value);if(/(^|\.)hivemind\.davinciai\.eu$/.test(u.hostname))return 'https://core.singulancelabs.com';return u.origin}catch{return 'https://core.singulancelabs.com'}}
 root.HMMeeting={detect,apiOrigin,WEB:'https://next.singulancelabs.com',CORE:'https://core.singulancelabs.com',CONTROL:'https://api.singulancelabs.com'};
})(globalThis);
