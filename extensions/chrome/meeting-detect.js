(()=>{
 let current='';
 function check(){const meeting=HMMeeting.detect(location.href);if(!meeting){document.getElementById('hivemind-meeting-companion')?.remove();current='';return}if(current===meeting.url)return;current=meeting.url;
  document.getElementById('hivemind-meeting-companion')?.remove();
  const host=document.createElement('div');host.id='hivemind-meeting-companion';host.style.cssText='position:fixed;bottom:24px;right:24px;z-index:2147483646';
  const shadow=host.attachShadow({mode:'closed'});
  shadow.innerHTML=`<style>:host{font:14px system-ui;color:#172d29}.card{width:290px;background:#fcfbf8;border:1px solid #d9e2dc;border-radius:18px;padding:18px;box-shadow:0 10px 40px #0002}p{color:#53665f;line-height:1.5;margin:8px 0 14px}button{font:inherit;cursor:pointer;border:0;border-radius:22px;padding:10px 15px;background:#166b58;color:white}.close{float:right;padding:0 4px;background:none;color:#53665f;font-size:20px}button:focus-visible{outline:3px solid #75adff;outline-offset:3px}</style><section class="card" aria-label="HIVEMIND meeting companion"><button class="close" aria-label="Dismiss">×</button><strong>HIVEMIND is ready for your meeting</strong><p>Private assistance and meeting notes. Recording starts only when you choose.</p><button class="open">Open companion</button></section>`;
  shadow.querySelector('.close').onclick=()=>host.remove();
  shadow.querySelector('.open').onclick=()=>chrome.runtime.sendMessage({action:'hm-meeting-open'});
  document.documentElement.append(host);chrome.runtime.sendMessage({action:'hm-meeting-detected'}).catch(()=>{});
 }
 check();setInterval(check,2500);
})();
