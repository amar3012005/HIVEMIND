// browser-actions.js — injected into the active tab on demand, same pattern as
// autofill.js: exposes window.__hmBrowserActions in the extension's isolated
// world, so background.js calls it after chrome.scripting.executeScript.
//
// This is the extension-side twin of services/hm-playwright's /v1/sessions —
// same action set (navigate is done by background.js via chrome.tabs, not
// here), same principle: read actions (extract/scroll/screenshot/snapshot)
// are structurally safe: nothing here can post/like/follow/send by itself.
(() => {
  if (window.__hmBrowserActions) return;

  // ─── Ghost cursor — reused verbatim from autofill.js's visual language so
  // any HIVEMIND-driven action in a page reads consistently to the user. ───
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

  // ─── extract: same shape as hm-playwright's extractPage() server-side, so
  // an agent gets one consistent evidence shape regardless of which runtime
  // (headless copy vs the user's real tab) produced it. ────────────────────
  function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
  function extract() {
    const root = document.querySelector('main, article, [role="main"]') || document.body || document.documentElement;
    const links = [...document.querySelectorAll('a[href]')].map((node) => {
      try {
        const url = new URL(node.getAttribute('href'), location.href);
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        url.hash = '';
        return { href: url.href, text: clean(node.textContent), title: clean(node.getAttribute('title')) };
      } catch { return null; }
    }).filter(Boolean).slice(0, 150);
    const text = clean(root.innerText || root.textContent).slice(0, 120000);
    return {
      url: location.href,
      title: clean(document.title),
      description: clean(document.querySelector('meta[name="description"]')?.content),
      h1: [...document.querySelectorAll('h1')].map((node) => clean(node.textContent)).filter(Boolean),
      text,
      wordCount: text.split(/\s+/).filter((word) => word.length > 1).length,
      links,
    };
  }

  // ─── scroll: identical direction/amount contract to hm-playwright's ──────
  function scroll(direction, amount) {
    const amt = Math.max(0, Math.min(Number(amount) || 800, 4000));
    if (direction === 'top') window.scrollTo(0, 0);
    else if (direction === 'bottom') window.scrollTo(0, document.body.scrollHeight);
    else window.scrollBy(0, direction === 'up' ? -amt : amt);
    return { ok: true };
  }

  // Same word list as services/hm-playwright/server.mjs's guard, deliberately
  // duplicated rather than shared (this runs in an isolated browser world with
  // no module loader) — keep the two lists in sync by hand if either changes.
  // NOT YET WIRED to an actual click execution here — see the PR description
  // for why (this environment's own permission classifier, not a technical gap).
  const BLOCKED_CLICK_WORDS = [
    'follow', 'unfollow', 'like', 'unlike', 'love',
    'send', 'message', 'dm', 'post', 'share', 'comment', 'reply',
    'delete', 'remove', 'block', 'unblock', 'report',
    'buy', 'purchase', 'checkout', 'subscribe', 'unsubscribe', 'pay', 'donate',
    'invite', 'connect', 'accept', 'decline',
  ];
  function matchedBlockedWord(label) {
    const lower = String(label || '').toLowerCase();
    for (const word of BLOCKED_CLICK_WORDS) {
      if (new RegExp(`\\b${word}\\b`).test(lower)) return word;
    }
    return null;
  }
  function describeElement(el) {
    if (!el) return '';
    return (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().slice(0, 200);
  }

  window.__hmBrowserActions = { extract, scroll, ensureCursor, moveCursor, ripple, sleep, matchedBlockedWord, describeElement };
})();
