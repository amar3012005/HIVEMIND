// autofill.js — injected into the active tab on the autofill gesture.
// Exposes window.__hmAutofill = { scan, run } in the extension's isolated world,
// so background.js can call scan() (read form fields) then run(fills) (ghost
// cursor glides field→field and fills, grounded values only, never submits).
(() => {
  if (window.__hmAutofill) return;

  // ─── Ghost cursor (visual-copilot style) ───────────────────────────────
  let cursorEl = null;
  function ensureCursor() {
    if (cursorEl) return cursorEl;
    cursorEl = document.createElement('div');
    cursorEl.id = '__hm_ghost_cursor';
    cursorEl.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:26px;height:26px;transition:transform .5s cubic-bezier(.22,1,.36,1),opacity .4s;will-change:transform;filter:drop-shadow(0 2px 4px rgba(17,125,255,.4));';
    cursorEl.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M5 3l14 7-6 2-2 6-6-15z" fill="#117dff" stroke="#fff" stroke-width="1.3"/></svg>';
    document.documentElement.appendChild(cursorEl);
    return cursorEl;
  }
  function moveCursor(x, y) { ensureCursor().style.transform = `translate(${x}px, ${y}px)`; }
  function ripple(x, y) {
    const r = document.createElement('div');
    r.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:2147483646;pointer-events:none;width:12px;height:12px;border-radius:50%;background:rgba(17,125,255,.35);transform:translate(-50%,-50%) scale(1);transition:transform .55s,opacity .55s;`;
    document.documentElement.appendChild(r);
    requestAnimationFrame(() => { r.style.transform = 'translate(-50%,-50%) scale(4.5)'; r.style.opacity = '0'; });
    setTimeout(() => r.remove(), 650);
  }
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  // ─── Field scan ────────────────────────────────────────────────────────
  function labelFor(el) {
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l && l.innerText.trim()) return l.innerText.trim().slice(0, 80); }
    const wrap = el.closest('label'); if (wrap && wrap.innerText.trim()) return wrap.innerText.trim().slice(0, 80);
    return (el.getAttribute('aria-label') || el.placeholder || el.name || '').slice(0, 80);
  }
  function scan() {
    const SKIP = ['hidden', 'submit', 'button', 'image', 'reset', 'file', 'password']; // never touch passwords/files
    const els = [...document.querySelectorAll('input,textarea,select')].filter((el) => {
      const t = (el.type || '').toLowerCase();
      if (SKIP.includes(t)) return false;
      if (el.disabled || el.readOnly) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 4 && r.height >= 4;
    }).slice(0, 60);
    return els.map((el, i) => {
      const r = el.getBoundingClientRect();
      const key = `hf_${i}`;
      el.setAttribute('data-hm-af', key);
      return {
        key, selector: `[data-hm-af="${key}"]`,
        label: labelFor(el), name: el.name || '',
        type: el.type || el.tagName.toLowerCase(), placeholder: el.placeholder || '',
        bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      };
    });
  }

  // ─── Fill (React/Vue-safe native setter + events) ──────────────────────
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  async function run(fills) {
    let done = 0;
    for (const f of (fills || [])) {
      const el = document.querySelector(f.selector || `[data-hm-af="${f.key}"]`);
      if (!el) continue;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(120);
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2; const cy = r.y + r.height / 2;
      moveCursor(cx - 13, cy - 13);
      await sleep(550);
      el.style.transition = 'outline .2s'; el.style.outline = '2px solid #117dff';
      ripple(cx, cy);
      if (el.tagName === 'SELECT') {
        const opt = [...el.options].find((o) => o.text.trim().toLowerCase() === String(f.value).toLowerCase() || (o.value || '').toLowerCase() === String(f.value).toLowerCase());
        if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); }
      } else {
        try { el.focus(); } catch (e) { /* ignore */ }
        setNativeValue(el, f.value);
      }
      el.setAttribute('data-hm-filled', '1');
      setTimeout(() => { el.style.outline = '2px solid #fde68a'; el.style.background = '#fffbeb'; }, 350);
      done += 1;
      await sleep(280);
    }
    if (cursorEl) setTimeout(() => { cursorEl.style.opacity = '0'; }, 900);
    return { filled: done };
  }

  window.__hmAutofill = { scan, run };
})();
