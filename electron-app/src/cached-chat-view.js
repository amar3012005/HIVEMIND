// A presentation-only loading layer in the current conversation. Native chat
// remains the sole owner of live state, composer, approvals and history fetches.
function presentCachedChat(input) {
  const key = '__singulanceCachedChat';
  const old = window[key];
  if (window.__singulanceCacheDismissed && window.__singulanceCacheDismissed !== location.href) delete window.__singulanceCacheDismissed;
  if (!input || location.href !== input.location || window.__singulanceCacheDismissed === input.location) { old?.close(); return false; }
  const native = document.querySelector('[data-native-chat="true"]');
  const target = input.provider === 'Runtime / DSH' ? native?.querySelector('[data-conversation-scroll]')
    : [...document.querySelectorAll('iframe')].find(el => {
      try { const url = new URL(el.src); return url.origin === 'https://dots.singulancelabs.com' && url.pathname === input.framePath && url.searchParams.get('c') === new URL(input.route).searchParams.get('c'); } catch { return false; }
    });
  if (!target || !target.getClientRects().length) { old?.close(); return false; }
  if (input.live || (native && native.dataset.phase !== 'settling' && input.provider === 'Runtime / DSH')) { old?.close(); return false; }
  if (old?.route === input.route) return true;
  old?.close();
  const host = document.createElement('div'); host.dataset.desktopCachedChat = '';
  const shadow = host.attachShadow({mode:'open'});
  const style = document.createElement('style');
  style.textContent = `:host{position:fixed;z-index:50;background:#faf9f5;color:#252525;font:15px/1.55 system-ui;display:flex;flex-direction:column;contain:layout paint}header{padding:12px 24px;border-bottom:1px solid #8882;font-size:12px;color:#62666c;display:flex;justify-content:space-between;gap:16px}section{overflow:auto;overscroll-behavior:contain;flex:1;min-height:0;padding:16px 24px}article{max-width:850px;margin:12px auto;padding:12px 16px;border-radius:18px;white-space:pre-wrap;overflow-wrap:anywhere;background:#fff}article[data-role=user]{background:#ececef}article[data-role=team]{background:#dcf3f7}b{display:block;font-size:12px;color:#62666c;margin-bottom:6px}button{font:inherit;color:inherit;background:none;border:1px solid #8884;border-radius:12px;padding:4px 12px;cursor:pointer}.older{display:block;margin:0 auto 12px}[hidden]{display:none!important}footer{padding:10px 24px;text-align:center;font-size:12px;color:#62666c}`;
  const header = document.createElement('header'), label = document.createElement('span'), dismiss = document.createElement('button');
  label.textContent = `${input.title} · Saved on this Mac · Updating…`; dismiss.textContent = 'Show live view';
  header.append(label,dismiss);
  const section = document.createElement('section'), older = document.createElement('button'); older.className='older'; older.textContent='Load earlier saved messages';
  section.append(older);
  const footer = document.createElement('footer'); footer.textContent='Read-only saved messages. Live controls return when the conversation is ready.';
  shadow.append(style,header,section,footer);
  let offset=input.messages.length, disposed=false;
  function page() {
    const height=section.scrollHeight, scroll=section.scrollTop;
    const start=Math.max(0,offset-30), fragment=document.createDocumentFragment();
    for(const row of input.messages.slice(start,offset)) {const article=document.createElement('article'),who=document.createElement('b'),text=document.createElement('span');article.dataset.role=row.role;who.textContent=row.role==='user'?'You':row.role==='team'?'Team':input.title;text.textContent=row.text;article.append(who,text);fragment.append(article);}
    older.after(fragment); offset=start; older.hidden=offset===0;
    section.scrollTop=scroll+section.scrollHeight-height;
  }
  older.onclick=page;
  section.addEventListener('scroll',()=>{if(section.scrollTop<40&&offset>0)page();},{passive:true});
  const sync=()=>{ if(disposed)return; if(location.href!==input.location || !target.isConnected){close();return;} const r=target.getBoundingClientRect();Object.assign(host.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:Math.max(0,Math.min(r.height,innerHeight-r.top))+'px'});};
  const resize=new ResizeObserver(sync);resize.observe(target);
  function close(){if(disposed)return;disposed=true;resize.disconnect();window.removeEventListener('resize',sync);clearInterval(guard);host.remove();if(window[key]?.host===host)delete window[key];}
  dismiss.onclick=()=>{window.__singulanceCacheDismissed=input.location;close();};
  const guard=setInterval(sync,100);
  window.addEventListener('resize',sync);
  document.body.append(host);sync();page();section.scrollTop=section.scrollHeight;
  window[key]={route:input.route,host,close};return true;
}
module.exports={presentCachedChat};
