/**
 * Talk to HIVE — side-panel chat.
 * Uses /api/chat via background.js. Sources collapsible. Token counters.
 */

const $ = (id) => document.getElementById(id);

const state = {
  history: [],
  sending: false,
  signedIn: false,
  email: '',
  model: 'GPT-OSS 120B',
  context: null, // { mode: 'selection'|'section'|'page', text, heading?, url, title }
};

document.addEventListener('DOMContentLoaded', async () => {
  try { chrome.runtime.connect({ name: 'side-panel' }); } catch {}

  const cfg = await chrome.storage.local.get(['apiKey', 'userEmail']);
  if (cfg.apiKey) {
    state.signedIn = true;
    state.email = cfg.userEmail || '';
    renderSignedIn();
  } else {
    renderSignedOut();
  }

  wireEvents();
  refreshPlatformBadge();
  refreshScopePill();
});

function renderSignedOut() {
  $('hero').classList.remove('hidden');
  $('messages').classList.add('hidden');
  $('composer').classList.add('hidden');
  $('userPill').textContent = '';
}

function renderSignedIn() {
  $('hero').classList.add('hidden');
  $('messages').classList.remove('hidden');
  $('composer').classList.remove('hidden');
  $('userPill').textContent = state.email;
  $('input').focus();
}

/**
 * Inline post-OAuth confirmation. Replaces the hero "Sign in with browser"
 * with a "Verified as <email>" green-checked card so the user never feels
 * like auth happened on a different page. The card auto-dismisses into
 * the chat surface ~1.5s later (handled by caller).
 */
function showVerifiedCard(email) {
  const hero = $('hero');
  if (!hero) return;
  hero.classList.remove('hidden');
  hero.innerHTML = `
    <div class="verified-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </div>
    <div class="hero-title">Verified</div>
    <div class="hero-sub">Signed in as <strong>${escapeHtml(email || 'your account')}</strong>. Bringing you in…</div>
  `;
}

function wireEvents() {
  $('heroSignIn').addEventListener('click', async () => {
    const btn = $('heroSignIn');
    btn.disabled = true;
    btn.textContent = 'Opening browser…';
    try {
      const resp = await chrome.runtime.sendMessage({
        action: 'signIn',
        apiBase: 'https://api.hivemind.davinciai.eu:8040',
      });
      if (!resp?.success) throw new Error(resp?.error || 'sign-in failed');
      const cfg = await chrome.storage.local.get(['apiKey', 'userEmail']);
      state.signedIn = true;
      state.email = cfg.userEmail || '';
      // Show inline "Verified as X" card for ~1.5s before flipping to the
      // signed-in chat surface. Feels like a real handshake completed
      // inside the panel — no extra browser tabs, no flashing UI.
      showVerifiedCard(state.email);
      setTimeout(() => renderSignedIn(), 1400);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Sign in with browser';
      appendError(e.message);
    }
  });

  $('newChatBtn').addEventListener('click', () => {
    state.history = [];
    // Rebuild welcome block (innerHTML wipe would lose listeners; just re-add).
    const msgs = $('messages');
    msgs.innerHTML = `
      <div id="welcome" class="welcome">
        <div class="welcome-title">Ask Me Anything</div>
        <div class="welcome-sub">Your second brain — always on, always remembering. Recalls context across tabs, sessions, and tools, then answers like you've known each other for years.</div>
        <div class="welcome-prompts">
          <button class="wp" data-prompt="What have I been working on lately?">What have I been working on lately?</button>
          <button class="wp" data-prompt="Summarize my recent decisions">Summarize my recent decisions</button>
          <button class="wp" data-prompt="What are my key preferences?">What are my key preferences?</button>
        </div>
        <div class="qr-card" id="qrCard">
          <div class="qr-card-text">
            <div class="qr-card-title">Use on your phone</div>
            <div class="qr-card-sub">Scan to open Talk to HIVE on mobile — same memory, save from anywhere.</div>
            <div class="qr-card-url" id="qrCardUrl"></div>
          </div>
          <div class="qr-code" id="qrCanvas"></div>
        </div>
      </div>`;
    msgs.querySelectorAll('.wp').forEach((btn) => {
      btn.addEventListener('click', () => {
        $('input').value = btn.dataset.prompt || btn.textContent.trim();
        send();
      });
    });
    renderMobileQR();
    $('input').focus();
  });

  const input = $('input');
  const counter = $('charCounter');
  const updateCounter = () => {
    const n = input.value.length;
    if (counter) {
      counter.textContent = `${n}/2000`;
      counter.classList.toggle('near', n >= 1700 && n < 2000);
      counter.classList.toggle('over', n >= 2000);
    }
  };
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    updateCounter();
  });
  updateCounter();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
    if (e.key === 'Escape') {
      window.close();
    }
  });

  $('sendBtn').addEventListener('click', send);

  // ── Context controls ──
  $('selBtn').addEventListener('click', async () => {
    // Try a couple of times — first click also kicks off tracker injection,
    // and the tracker fires `selectionchange` once it lands which writes
    // the current selection to chrome.storage.session.
    let ctx = await chrome.runtime.sendMessage({ action: 'getSelectionContext' });
    if (!ctx?.text) {
      await new Promise((r) => setTimeout(r, 180));
      ctx = await chrome.runtime.sendMessage({ action: 'getSelectionContext' });
    }
    if (!ctx?.text) {
      appendError('No text selected on the page. Highlight something then click again.');
      return;
    }
    setContext(ctx);
  });

  $('sectionBtn').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'startSectionPicker' });
    flashHint('Drawer active on page — hover & click a section. Esc to cancel.');
  });

  $('pageBtn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    setContext({ mode: 'page', url: tab?.url || '', title: tab?.title || '', text: '' });
  });

  $('ctxClear').addEventListener('click', () => setContext(null));

  $('saveMemBtn').addEventListener('click', saveCurrentContextAsMemory);

  // Upload button → opens file picker, routes by MIME (image vs document)
  const uploadBtn = $('uploadBtn');
  const uploadInput = $('uploadInput');
  if (uploadBtn && uploadInput) {
    uploadBtn.addEventListener('click', () => uploadInput.click());
    uploadInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      uploadInput.value = ''; // allow same file re-pick
      for (const f of files) {
        await handleFileUpload(f);
      }
    });
  }

  // Welcome example prompts → fill composer + auto-send
  document.querySelectorAll('.wp').forEach((btn) => {
    btn.addEventListener('click', () => {
      const prompt = btn.dataset.prompt || btn.textContent.trim();
      const input = $('input');
      input.value = prompt;
      input.focus();
      send();
    });
  });

  // Mobile QR pairing — paints once the welcome surface is visible.
  renderMobileQR();

  // Save-session button (the actual interactive entry point)
  $('ssbBtn').addEventListener('click', ingestActiveChat);

  // Scope pill — toggle dropdown menu w/ project list + create.
  const scopePill = $('scopePill');
  const scopeMenu = $('scopeMenu');
  if (scopePill && scopeMenu) {
    scopePill.addEventListener('click', async (e) => {
      e.stopPropagation();
      const opening = scopeMenu.classList.contains('hidden');
      scopeMenu.classList.toggle('hidden');
      scopePill.setAttribute('aria-expanded', String(opening));
      if (opening) await populateScopeMenu();
    });
    document.addEventListener('click', (e) => {
      if (!scopeMenu.classList.contains('hidden') && !scopeMenu.contains(e.target) && e.target !== scopePill) {
        scopeMenu.classList.add('hidden');
        scopePill.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !scopeMenu.classList.contains('hidden')) {
        scopeMenu.classList.add('hidden');
        scopePill.setAttribute('aria-expanded', 'false');
      }
    });

    scopeMenu.addEventListener('click', async (e) => {
      const item = e.target.closest('.sm-item');
      if (!item) return;
      if (item.id === 'smCreateBtn') {
        openCreateProjectModal();
        return;
      }
      const kind = item.dataset.scopeKind;
      if (kind === 'org') {
        await chrome.runtime.sendMessage({ action: 'setScope', scope: { kind: 'org' } });
        renderScopePill({ kind: 'org' });
        scopeMenu.classList.add('hidden');
        return;
      }
      if (kind === 'project') {
        const pid = item.dataset.projectId;
        const pname = item.dataset.projectName;
        if (!pid) return;
        await chrome.runtime.sendMessage({
          action: 'setScope',
          scope: { kind: 'project', projectId: pid, projectName: pname },
        });
        renderScopePill({ kind: 'project', projectId: pid, projectName: pname });
        scopeMenu.classList.add('hidden');
      }
    });
  }

  // Language pill — picks reply language, persisted to chrome.storage.local
  // under `lang`. Each /api/chat call appends `language` + the wire-only
  // strict directive (mirrors dashboard Talk-to-HIVE behaviour).
  const langPill = $('langPill');
  const langMenu = $('langMenu');
  if (langPill && langMenu) {
    const renderLang = (code) => {
      const c = (code || 'en').toLowerCase();
      const lp = document.getElementById('lpLabel');
      if (lp) lp.textContent = c.toUpperCase();
      langMenu.querySelectorAll('.sm-item').forEach((el) => {
        el.classList.toggle('active', el.dataset.lang === c);
      });
    };

    // Hydrate from storage
    chrome.storage.local.get(['lang']).then(({ lang }) => renderLang(lang || 'en'));

    langPill.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = langMenu.classList.contains('hidden');
      // Close scope menu if open
      if (scopeMenu) scopeMenu.classList.add('hidden');
      langMenu.classList.toggle('hidden');
      langPill.setAttribute('aria-expanded', String(opening));
    });
    document.addEventListener('click', (e) => {
      if (!langMenu.classList.contains('hidden') && !langMenu.contains(e.target) && e.target !== langPill) {
        langMenu.classList.add('hidden');
        langPill.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !langMenu.classList.contains('hidden')) {
        langMenu.classList.add('hidden');
        langPill.setAttribute('aria-expanded', 'false');
      }
    });
    langMenu.addEventListener('click', async (e) => {
      const item = e.target.closest('.sm-item');
      if (!item) return;
      const code = item.dataset.lang;
      if (!code) return;
      await chrome.storage.local.set({ lang: code });
      renderLang(code);
      langMenu.classList.add('hidden');
      langPill.setAttribute('aria-expanded', 'false');
      try { chrome.runtime.sendMessage({ action: 'langChanged', lang: code }); } catch {}
    });
  }

  // Section pick broadcast from background → content-script
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'platformChanged') {
      renderPlatformBadge(msg);
      return;
    }
    if (msg.action === 'scopeChanged') {
      renderScopePill(msg.scope || { kind: 'org' });
      return;
    }
    if (msg.action === 'sectionContextReady' && msg.section) {
      setContext(msg.section);
      return;
    }

    // Context-menu → MCP routing: right-click on a selection produces an
    // event that prefills the composer (and optionally pins context) so
    // the user just hits Enter to dispatch the MCP tool through the agent.
    if (msg.action === 'mcpSelectionPrefill' && msg.selection) {
      setContext({
        mode: 'selection',
        text: msg.selection,
        url: msg.url,
        title: msg.title,
        length: msg.selection.length,
      });
      const input = $('input');
      const verb = msg.op === 'log_decision'
        ? 'Log a decision based on this selection'
        : 'Ask Hive: ';
      input.value = verb;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }

    if (msg.action === 'mcpPagePrefill') {
      setContext({
        mode: 'page',
        url: msg.url,
        title: msg.title,
        length: 0,
      });
      const input = $('input');
      input.value = 'Tell me about this page: ';
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }

    // Right-click "Recall similar memories" broadcasts results — render
    // them as a system-style message so the user sees what HIVEMIND has
    // for that selection without having to type a query.
    if (msg.action === 'mcpResultBroadcast' && msg.op === 'recall') {
      const lines = (msg.memories || []).slice(0, 6).map((m, i) =>
        `${i + 1}. ${(m.title || (m.content || '').slice(0, 80) || '(untitled)').replace(/\n+/g, ' ')}`
      ).join('\n');
      flashHint(
        `🔎 Recall: "${(msg.query || '').slice(0, 60)}"\n` +
        (lines || '(no similar memories found)')
      );
      return;
    }
  });
}

function setContext(ctx) {
  state.context = ctx;
  const pill = $('ctxPill');
  if (!ctx) {
    pill.classList.add('hidden');
    document.querySelectorAll('.ctx-btn').forEach(b => b.classList.remove('active'));
    return;
  }
  pill.classList.remove('hidden');
  document.querySelectorAll('.ctx-btn').forEach(b => b.classList.remove('active'));
  if (ctx.mode === 'selection') $('selBtn').classList.add('active');
  if (ctx.mode === 'section') $('sectionBtn').classList.add('active');
  if (ctx.mode === 'page') $('pageBtn').classList.add('active');

  let label = '';
  if (ctx.mode === 'selection') {
    label = `"${(ctx.text || '').slice(0, 60).replace(/\s+/g, ' ')}${(ctx.text || '').length > 60 ? '…' : ''}"`;
  } else if (ctx.mode === 'section') {
    label = ctx.heading ? `§ ${ctx.heading}` : `§ ${ctx.selector || 'section'}`;
  } else {
    label = ctx.title || ctx.url || 'Page';
  }
  $('ctxLabel').textContent = label;
  $('ctxMeta').textContent = ctx.length ? `${ctx.length}c` : (ctx.mode === 'page' ? 'page' : '');
}

function flashHint(text) {
  const el = document.createElement('div');
  el.className = 'err-msg';
  el.style.background = '#eff6ff';
  el.style.borderColor = '#bfdbfe';
  el.style.color = '#117dff';
  el.textContent = text;
  $('messages').appendChild(el);
  scrollBottom();
  setTimeout(() => el.remove(), 4000);
}

async function send() {
  if (state.sending) return;
  if (!state.signedIn) return;
  const input = $('input');
  const text = input.value.trim();
  if (!text) return;

  state.sending = true;
  input.value = '';
  input.style.height = 'auto';
  $('sendBtn').disabled = true;

  appendUser(text);
  state.history.push({ role: 'user', content: text });

  const streamId = 'sm-' + Math.random().toString(36).slice(2, 10);
  const aiEl = appendStreamingAi();
  const stepsList = aiEl.querySelector('.steps-list');
  const stepsToggle = aiEl.querySelector('.steps-toggle');
  const stepsCountEl = aiEl.querySelector('.steps-count');
  let stepCount = 0;

  const listener = (msg) => {
    if (msg.action !== 'chatStreamChunk' || msg.streamId !== streamId) return;
    const evt = msg.event;
    if (!evt) return;

    if (evt.type === 'tool_call') {
      stepCount++;
      stepsToggle.classList.remove('hidden');
      stepsCountEl.textContent = stepCount;
      const li = document.createElement('div');
      li.className = 'step-item';
      li.dataset.tool = evt.name;
      li.innerHTML = `<span class="step-icon">🔧</span> <code>${escapeHtml(evt.name)}</code> <span class="step-args">${escapeHtml(briefArgs(evt.arguments))}</span> <span class="step-status">…</span>`;
      stepsList.appendChild(li);

      // Inline saving chip — only for memory write ops so the user sees
      // HIVE actually committing memory while the answer is still streaming.
      if (/^hivemind_(save_memory|update_memory|log_decision|delete_memory|set_assistant_name)$/.test(evt.name)) {
        showSavingChip(evt.name, briefArgs(evt.arguments));
      }
    }
    if (evt.type === 'tool_result') {
      const items = stepsList.querySelectorAll('.step-item');
      const last = items[items.length - 1];
      if (last) {
        const status = last.querySelector('.step-status');
        if (status) status.textContent = '→ ' + (evt.summary || 'ok');
        const toolName = last.dataset.tool;
        if (/^hivemind_(save_memory|update_memory|log_decision|delete_memory|set_assistant_name)$/.test(toolName)) {
          finalizeSavingChip(toolName, evt.summary || 'saved');
        }
      }
    }
    if (evt.type === 'done' || evt.type === 'finish') {
      const reply = evt.type === 'done' ? evt : { reply: evt.text };
      reply.reply = reply.response || reply.reply || evt.text;
      reply.sources = reply.sources || [];
      reply.usage = reply.usage;
      finalizeStreamingAi(aiEl, reply);
      state.history.push({ role: 'assistant', content: reply.reply });
      cleanup();
    }
    if (evt.type === 'error') {
      aiEl.remove();
      appendError(evt.error || 'agent error');
      cleanup();
    }
  };

  const cleanup = () => {
    chrome.runtime.onMessage.removeListener(listener);
    state.sending = false;
    $('sendBtn').disabled = false;
    $('input').focus();
  };

  chrome.runtime.onMessage.addListener(listener);

  try {
    await chrome.runtime.sendMessage({
      action: 'chatMessageStream',
      streamId,
      message: text,
      history: state.history.slice(-12),
      context: state.context,
    });
  } catch (e) {
    aiEl.remove();
    appendError(e.message);
    cleanup();
  }
}

// ── Saving-memory animated chip ─────────────────────────────────────────────
// Pulses while a save_memory / update_memory tool call is in flight. Turns
// green-checked when the tool_result event lands.

const SAVE_LABELS = {
  hivemind_save_memory: 'Saving to memory',
  hivemind_update_memory: 'Updating memory',
  hivemind_log_decision: 'Logging decision',
  hivemind_delete_memory: 'Forgetting',
  hivemind_set_assistant_name: 'Setting name',
};

const _savingChipQueue = [];

function showSavingChip(toolName, detail) {
  const wrap = document.createElement('div');
  wrap.className = 'saving-chip';
  wrap.dataset.tool = toolName;
  wrap.innerHTML = `
    <span class="sc-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
      </svg>
    </span>
    <span>${SAVE_LABELS[toolName] || 'Saving'}…</span>
    ${detail ? `<span class="sc-detail">${escapeHtml(detail)}</span>` : ''}
  `;
  $('messages').appendChild(wrap);
  _savingChipQueue.push(wrap);
  scrollBottom();
}

function finalizeSavingChip(toolName, summary) {
  // Match the FIFO order — finalize the oldest unfinished chip for this tool.
  const idx = _savingChipQueue.findIndex((c) => c.dataset.tool === toolName && !c.classList.contains('done'));
  const chip = idx >= 0 ? _savingChipQueue[idx] : _savingChipQueue.find((c) => !c.classList.contains('done'));
  if (!chip) return;
  chip.classList.add('done');
  const labelSpan = chip.querySelector('span:nth-of-type(2)');
  if (labelSpan) {
    labelSpan.textContent =
      toolName === 'hivemind_update_memory' ? 'Memory updated'
      : toolName === 'hivemind_delete_memory' ? 'Memory forgotten'
      : toolName === 'hivemind_log_decision' ? 'Decision logged'
      : 'Saved to memory';
  }
  // Replace spinning bookmark with green check.
  const icon = chip.querySelector('.sc-icon');
  if (icon) icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
  const detail = chip.querySelector('.sc-detail');
  if (detail && summary) detail.textContent = summary.slice(0, 40);
  setTimeout(() => {
    if (idx >= 0) _savingChipQueue.splice(idx, 1);
  }, 100);
}

// ── Mobile QR pairing (welcome state) ──────────────────────────────────────

const MOBILE_DEEP_LINK_BASE = 'https://hivemind.davinciai.eu/hivemind/m/chat';

function renderMobileQR() {
  const card = document.getElementById('qrCard');
  const canvas = document.getElementById('qrCanvas');
  const urlEl = document.getElementById('qrCardUrl');
  if (!card || !canvas) return;
  if (typeof qrcode === 'undefined') {
    // Library failed to load — silently hide the card.
    card.style.display = 'none';
    return;
  }
  const link = `${MOBILE_DEEP_LINK_BASE}?from=ext`;
  try {
    const qr = qrcode(0, 'M'); // type=auto, error-correction medium
    qr.addData(link);
    qr.make();
    // 4-px cell, no margin — fits 88px tile cleanly.
    canvas.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0 });
    if (urlEl) urlEl.textContent = link.replace(/^https?:\/\//, '');
  } catch (e) {
    console.warn('[qr] render failed:', e?.message);
    card.style.display = 'none';
  }
}

function hideWelcome() {
  const w = $('welcome');
  if (w) w.classList.add('hidden');
}

async function saveCurrentContextAsMemory() {
  const btn = $('saveMemBtn');
  const ctx = state.context;
  let payload;

  if (ctx && ctx.mode === 'selection' && ctx.text) {
    payload = {
      content: ctx.text,
      title: `Selection: ${ctx.text.slice(0, 60)}`,
      tags: ['browser-extension', 'selection', `url:${(ctx.url || '').split('/').slice(0, 3).join('/')}`],
    };
  } else if (ctx && ctx.mode === 'section' && ctx.text) {
    payload = {
      content: ctx.text,
      title: ctx.heading ? `Section: ${ctx.heading}` : `Section from ${ctx.title || ctx.url}`,
      tags: ['browser-extension', 'section', `url:${(ctx.url || '').split('/').slice(0, 3).join('/')}`],
    };
  } else if (ctx && ctx.mode === 'page') {
    // Trigger background savePage on active tab.
    btn.disabled = true;
    btn.textContent = 'Saving page…';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const result = await chrome.runtime.sendMessage({ action: 'savePage', tabId: tab.id });
      flashHint(result?.success ? '✅ Page saved to HIVE' : `⚠️ ${result?.error || 'save failed'}`);
    } catch (e) {
      flashHint(`⚠️ ${e.message}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> Save memory';
    }
    return;
  } else {
    flashHint('Pick context first (Selection / Section / Page) before saving.');
    return;
  }

  btn.disabled = true;
  const prevHTML = btn.innerHTML;
  btn.textContent = 'Saving…';
  try {
    const result = await chrome.runtime.sendMessage({ action: 'saveText', ...payload });
    flashHint(result?.success ? '✅ Saved to HIVE' : `⚠️ ${result?.error || 'save failed'}`);
  } catch (e) {
    flashHint(`⚠️ ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = prevHTML;
  }
}

function appendUser(text) {
  hideWelcome();
  const wrap = document.createElement('div');
  wrap.className = 'msg-user';
  const b = document.createElement('div');
  b.className = 'bubble-user';
  b.textContent = text;
  wrap.appendChild(b);
  $('messages').appendChild(wrap);
  scrollBottom();
}

function appendStreamingAi() {
  const wrap = document.createElement('div');
  wrap.className = 'msg-ai';
  wrap.innerHTML = `
    <div class="ai-header">
      <div class="ai-avatar"><img src="Hivemind_extension.png" alt="" /></div>
      <span class="ai-name">HIVE</span>
      <span class="ai-dot">·</span>
      <span class="ai-model">${escapeHtml(state.model)}</span>
    </div>
    <div class="ai-card">
      <div class="steps-toggle hidden" data-open="0">
        <span>⚙</span> <span class="steps-count">0</span> steps
        <span class="steps-caret">›</span>
      </div>
      <div class="steps-list hidden"></div>
      <div class="ai-text">
        <div class="thinking">
          <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        </div>
      </div>
    </div>`;
  $('messages').appendChild(wrap);

  const toggle = wrap.querySelector('.steps-toggle');
  toggle.addEventListener('click', () => {
    const list = wrap.querySelector('.steps-list');
    list.classList.toggle('hidden');
    toggle.dataset.open = list.classList.contains('hidden') ? '0' : '1';
  });

  scrollBottom();
  return wrap;
}

function finalizeStreamingAi(wrap, reply) {
  const text = (reply.reply || reply.response || '').trim();
  const sources = Array.isArray(reply?.sources) ? reply.sources : [];
  const promptTok = reply?.usage?.prompt_tokens ?? null;
  const compTok = reply?.usage?.completion_tokens ?? null;
  const totalTok = (promptTok != null && compTok != null) ? promptTok + compTok : (reply?.usage?.total_tokens ?? null);

  wrap.querySelector('.ai-text').innerHTML = renderMarkdownLite(text);

  if (sources.length || totalTok != null) {
    const card = wrap.querySelector('.ai-card');
    const sourcesId = 'src-' + Math.random().toString(36).slice(2, 8);
    const metaHtml = `
      <hr class="ai-divider" />
      <div class="ai-meta">
        ${sources.length ? `
          <span class="sources-toggle" data-target="${sourcesId}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
            ${sources.length} sources used <span style="font-size:9px;">›</span>
          </span>
        ` : ''}
        ${promptTok != null ? `<span><span class="tok-dot blue"></span> ${promptTok} prompt</span>` : ''}
        ${compTok != null ? `<span><span class="tok-dot green"></span> ${compTok} completion</span>` : ''}
        ${totalTok != null ? `<span>· ${totalTok} total</span>` : ''}
      </div>
      ${sources.length ? `<div class="sources-list hidden" id="${sourcesId}">
        ${sources.slice(0, 10).map(s => `
          <div class="source-item">
            <div class="source-title">${escapeHtml(s.title || 'Memory')}</div>
            ${s.snippet ? `<div>${escapeHtml((s.snippet || '').slice(0, 160))}</div>` : ''}
          </div>
        `).join('')}
      </div>` : ''}`;
    const div = document.createElement('div');
    div.innerHTML = metaHtml;
    while (div.firstChild) card.appendChild(div.firstChild);

    const toggle = wrap.querySelector('.sources-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const list = wrap.querySelector('#' + toggle.dataset.target);
        if (list) list.classList.toggle('hidden');
      });
    }
  }

  scrollBottom();
}

// ── Markdown-lite renderer (HTML string) ────────────────────────────────
// Mirrors the React renderMarkdownMobile in TalkToHiveMobile.jsx. Escapes
// input first then applies markdown patterns so user content can't inject
// HTML. Handles: code fences, pipe tables, headings, lists, blockquotes,
// inline bold / italic / code / links, paragraphs.

function _escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _mdInline(escaped) {
  // Operate on already-escaped text. Markdown chars (* ` [ ]) are not
  // affected by escapeHtml, so patterns still match.
  let s = escaped;
  // Bold (must run before italic so ** isn't consumed as two *)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic — single * not preceded/followed by *
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  // Inline code
  s = s.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
  // Links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) =>
    `<a href="${u}" target="_blank" rel="noreferrer noopener">${t}</a>`);
  return s;
}

function _isTableRow(line) { return /^\s*\|.*\|\s*$/.test(line); }
function _isTableSep(line) { return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line); }
function _parseTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

function renderMarkdownLite(raw) {
  if (!raw) return '';
  const lines = String(raw).replace(/^\s+|\s+$/g, '').split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Code fence
    if (/^```/.test(trimmed)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // closing fence
      out.push(`<pre class="md-pre"><code>${_escHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    if (!trimmed) { i++; continue; }

    // Pipe table
    if (_isTableRow(line) && i + 1 < lines.length && _isTableSep(lines[i + 1])) {
      const header = _parseTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && _isTableRow(lines[i])) {
        rows.push(_parseTableRow(lines[i]));
        i++;
      }
      const thead = header.map(h => `<th>${_mdInline(_escHtml(h))}</th>`).join('');
      const tbody = rows.map(r =>
        `<tr>${r.map(c => `<td>${_mdInline(_escHtml(c))}</td>`).join('')}</tr>`
      ).join('');
      out.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`);
      continue;
    }

    // Heading
    const h = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      const lvl = h[1].length;
      out.push(`<div class="md-h md-h${lvl}">${_mdInline(_escHtml(h[2]))}</div>`);
      i++;
      continue;
    }

    // Bullet list
    if (/^\s*[*-]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[*-]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[*-]\s+/, ''));
        i++;
      }
      out.push(`<ul class="md-ul">${items.map(it => `<li>${_mdInline(_escHtml(it))}</li>`).join('')}</ul>`);
      continue;
    }

    // Numbered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push(`<ol class="md-ol">${items.map(it => `<li>${_mdInline(_escHtml(it))}</li>`).join('')}</ol>`);
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote class="md-bq">${_mdInline(_escHtml(buf.join(' ')))}</blockquote>`);
      continue;
    }

    // Paragraph
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|\s*[*-]\s+|\s*\d+\.\s+|```|>\s?)/.test(lines[i]) &&
      !(_isTableRow(lines[i]) && i + 1 < lines.length && _isTableSep(lines[i + 1]))
    ) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) out.push(`<p class="md-p">${_mdInline(_escHtml(para.join(' ')))}</p>`);
  }
  return out.join('');
}

// ── File upload (auto-route by MIME) ────────────────────────────────────
// Image → Groq vision pipeline via /api/ingest/image (server runs classify
// + extract). Everything else → /api/knowledge/upload (docling pipeline).
// Renders a compact row in #uploadList showing status + memory id when done.

async function handleFileUpload(file) {
  const list = $('uploadList');
  if (!list) return;
  const mime = (file.type || '').toLowerCase();
  const isImage = /^image\/(png|jpe?g|webp|gif)$/.test(mime);
  const cfg = await getConfig();
  if (!cfg.apiKey) {
    appendError('Not signed in — upload skipped.');
    return;
  }

  const rowId = 'ur-' + Math.random().toString(36).slice(2, 8);
  const row = document.createElement('div');
  row.className = 'upload-row';
  row.id = rowId;
  row.innerHTML = `
    <span class="ur-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
        ${isImage
          ? '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>'
          : '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'}
      </svg>
    </span>
    <span class="ur-name">${escapeHtml(file.name)}</span>
    <span class="ur-state">uploading…</span>
    <button class="ur-x" title="Dismiss">×</button>
  `;
  list.appendChild(row);
  row.querySelector('.ur-x').addEventListener('click', () => row.remove());

  // Get current project scope so server binds memory to it.
  let projectIdField = '';
  try {
    const { scope } = await chrome.storage.local.get(['scope']);
    if (scope?.kind === 'project' && scope.projectId) projectIdField = scope.projectId;
  } catch {}

  try {
    const fd = new FormData();
    fd.append('file', file);
    if (projectIdField) fd.append('projectId', projectIdField);
    const endpoint = isImage ? '/api/ingest/image' : '/api/knowledge/upload';

    const resp = await fetch(`${cfg.apiBase}${endpoint}`, {
      method: 'POST',
      headers: { 'X-API-Key': cfg.apiKey },
      body: fd,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.error || `HTTP ${resp.status}`);
    }
    const memId = data?.memory_id || data?.id || data?.memory?.id || null;
    const title = data?.title || data?.classification?.suggested_title || file.name;
    const kind = data?.classification?.kind ? ` · ${data.classification.kind}` : '';
    row.classList.add('done');
    row.querySelector('.ur-name').textContent = title;
    row.querySelector('.ur-state').textContent = `saved${kind}${memId ? ' · ' + memId.slice(0, 8) : ''}`;
    setTimeout(() => { if (row.parentNode) row.remove(); }, 6000);
  } catch (err) {
    row.classList.add('error');
    row.querySelector('.ur-state').textContent = (err?.message || 'failed').slice(0, 60);
  }
}

function briefArgs(rawArgs) {
  if (!rawArgs) return '';
  let obj = rawArgs;
  if (typeof rawArgs === 'string') {
    try { obj = JSON.parse(rawArgs); } catch { return rawArgs.slice(0, 60); }
  }
  if (obj && typeof obj === 'object') {
    if (obj.query) return `"${String(obj.query).slice(0, 50)}"`;
    if (obj.url) return obj.url;
    if (obj.title) return `"${obj.title.slice(0, 40)}"`;
    if (obj.memory_id) return obj.memory_id.slice(0, 8);
    if (obj.id) return obj.id.slice(0, 8);
  }
  return '';
}

function appendThinking() {
  const wrap = document.createElement('div');
  wrap.className = 'msg-ai';
  wrap.innerHTML = `
    <div class="ai-header">
      <div class="ai-avatar"><img src="Hivemind_extension.png" alt="" /></div>
      <span class="ai-name">HIVE</span>
      <span class="ai-dot">·</span>
      <span class="ai-model">${escapeHtml(state.model)}</span>
    </div>
    <div class="ai-card">
      <div class="thinking">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
    </div>`;
  $('messages').appendChild(wrap);
  scrollBottom();
  return wrap;
}

function appendAssistant(reply) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-ai';

  const sources = Array.isArray(reply?.sources) ? reply.sources : [];
  const promptTok = reply?.usage?.prompt_tokens ?? reply?.prompt_tokens ?? null;
  const compTok = reply?.usage?.completion_tokens ?? reply?.completion_tokens ?? null;
  const totalTok = (promptTok != null && compTok != null) ? promptTok + compTok : (reply?.usage?.total_tokens ?? null);

  const sourcesId = 'src-' + Math.random().toString(36).slice(2, 8);

  wrap.innerHTML = `
    <div class="ai-header">
      <div class="ai-avatar"><img src="Hivemind_extension.png" alt="" /></div>
      <span class="ai-name">HIVE</span>
      <span class="ai-dot">·</span>
      <span class="ai-model">${escapeHtml(state.model)}</span>
    </div>
    <div class="ai-card">
      <div class="ai-text">${formatReply(reply?.reply || '')}</div>
      ${(sources.length || totalTok != null) ? `
        <hr class="ai-divider" />
        <div class="ai-meta">
          ${sources.length ? `
            <span class="sources-toggle" data-target="${sourcesId}">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
              ${sources.length} sources used <span style="font-size:9px;">›</span>
            </span>
          ` : ''}
          ${promptTok != null ? `<span><span class="tok-dot blue"></span> ${promptTok} prompt</span>` : ''}
          ${compTok != null ? `<span><span class="tok-dot green"></span> ${compTok} completion</span>` : ''}
          ${totalTok != null ? `<span>· ${totalTok} total</span>` : ''}
        </div>
        ${sources.length ? `<div class="sources-list hidden" id="${sourcesId}">
          ${sources.slice(0, 10).map(s => `
            <div class="source-item">
              <div class="source-title">${escapeHtml(s.title || s.memory_title || 'Memory')}</div>
              ${s.snippet || s.content ? `<div>${escapeHtml((s.snippet || s.content).slice(0, 160))}</div>` : ''}
            </div>
          `).join('')}
        </div>` : ''}
      ` : ''}
    </div>`;

  $('messages').appendChild(wrap);

  const toggle = wrap.querySelector('.sources-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const list = wrap.querySelector('#' + toggle.dataset.target);
      if (list) list.classList.toggle('hidden');
    });
  }
  scrollBottom();
}

function appendError(msg) {
  const el = document.createElement('div');
  el.className = 'err-msg';
  el.textContent = msg;
  $('messages').appendChild(el);
  scrollBottom();
}

function scrollBottom() {
  const m = $('messages');
  m.scrollTop = m.scrollHeight;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s == null ? '' : String(s);
  return div.innerHTML;
}

function formatReply(s) {
  return escapeHtml(s);
}

// ── AI Platform badge (live-updates from background broadcasts) ──────────────

async function refreshPlatformBadge() {
  try {
    const info = await chrome.runtime.sendMessage({ action: 'detectActivePlatform' });
    renderPlatformBadge(info);
  } catch {
    renderPlatformBadge({ matched: false });
  }
}

function renderPlatformBadge(info) {
  const badge = $('platformBadge');
  const bar = $('saveSessionBar');
  if (!badge || !bar) return;

  if (!info || !info.matched) {
    badge.classList.add('hidden');
    bar.classList.add('hidden');
    return;
  }

  badge.classList.remove('hidden');
  const nameEl = $('pbName');
  if (nameEl) nameEl.textContent = info.name || info.id || 'AI CHAT';
  badge.title = info.sessionId ? `${info.name} · session ${String(info.sessionId).slice(0, 8)}` : info.name;

  // Save-session bar
  bar.classList.remove('hidden');
  bar.dataset.platformId = info.id || '';
  bar.dataset.sessionId = info.sessionId || '';
  $('ssbPlatform').textContent = (info.name || 'this').toUpperCase();
  $('ssbSub').textContent = info.sessionId ? `· session ${String(info.sessionId).slice(0, 8)}` : '';
}

// ── Ingest stage pipeline ───────────────────────────────────────────────────
// Each stage is an independent persistent card in #messages so the user can
// scroll back through history of every chat-session ingest they've run.

const _activeStages = new Map(); // stage_id → element

// Lucide icon per memory_type — matches dashboard tile palette.
const MEM_TYPE_ICON = {
  fact:         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  preference:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  decision:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 21h-1l1-7H6.5c-.88 0-.33-.75-.31-.78C7.48 10.94 9.61 7.54 12.91 2h1l-1 7h4.51c.4 0 .62.19.4.66C13.57 14.54 11 21 11 21z"/></svg>',
  goal:         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
  event:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  lesson:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
  relationship: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
  note:         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>',
  conversation: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
};

function addMemoryTrace(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  hideWelcome();
  const wrap = document.createElement('div');
  wrap.className = 'mem-trace';
  const saved = rows.filter((r) => r.action === 'saved').length;
  const updated = rows.filter((r) => r.action === 'updated').length;
  const deduped = rows.filter((r) => r.action === 'deduped').length;
  wrap.innerHTML = `
    <div class="mem-trace-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      Saved to memory · ${saved} new · ${updated} updated · ${deduped} deduped
    </div>
    ${rows.map((r) => `
      <div class="mem-row">
        <span class="mr-icon mt-${escapeHtml(r.memory_type || 'note')}">${MEM_TYPE_ICON[r.memory_type] || MEM_TYPE_ICON.note}</span>
        <div class="mr-body">
          <div class="mr-title">${escapeHtml(r.title || '(untitled)')}</div>
          <div class="mr-meta">${escapeHtml(r.memory_type || 'note')}${r.tags?.length ? ' · ' + r.tags.slice(0, 4).map(escapeHtml).join(' · ') : ''}</div>
        </div>
        <span class="mr-action ${r.action}">${r.action}</span>
      </div>
    `).join('')}
  `;
  $('messages').appendChild(wrap);
  scrollBottom();
}

function addStageGroupHeader(text) {
  hideWelcome();
  const h = document.createElement('div');
  h.className = 'stage-group-header';
  h.textContent = text;
  $('messages').appendChild(h);
  scrollBottom();
  return h;
}

// Lucide SVG icon glyphs — match HIVEMIND dashboard sidebar theme.
const STAGE_ICONS = {
  search:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  pen:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  clock:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  camera:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="4"/></svg>',
  brain:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08A2.5 2.5 0 0 1 2.5 13.5a2.5 2.5 0 0 1 1.32-2.2 2.5 2.5 0 0 1 .85-3.95A2.5 2.5 0 0 1 5.5 4.5 2.5 2.5 0 0 1 9.5 2z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 2.5 2.5 0 0 0 1.58-3.36 2.5 2.5 0 0 0-1.32-2.2 2.5 2.5 0 0 0-.85-3.95A2.5 2.5 0 0 0 18.5 4.5 2.5 2.5 0 0 0 14.5 2z"/></svg>',
  help:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  warn:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  file:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  check:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  send:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  bookmark:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  zap:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
};

function addStage({ id, icon, title, detail = '', state = 'in-flight' }) {
  hideWelcome();
  const iconKey = icon || 'zap';
  const iconHtml = STAGE_ICONS[iconKey] || STAGE_ICONS.zap;
  const el = document.createElement('div');
  el.className = `stage-card ${state}`;
  el.dataset.stageId = id;
  el.dataset.iconKey = iconKey;
  el.innerHTML = `
    <span class="sg-icon ic-${iconKey}">${iconHtml}</span>
    <div class="sg-body">
      <div class="sg-title">${escapeHtml(title)}</div>
      ${detail ? `<div class="sg-detail">${escapeHtml(detail)}</div>` : ''}
    </div>`;
  $('messages').appendChild(el);
  _activeStages.set(id, el);
  scrollBottom();
  return el;
}

function updateStage(id, { title, detail, state, icon }) {
  const el = _activeStages.get(id);
  if (!el) return;
  if (typeof state === 'string') {
    el.classList.remove('in-flight', 'done', 'error');
    el.classList.add(state);
  }
  if (typeof icon === 'string') {
    const iconEl = el.querySelector('.sg-icon');
    if (iconEl) {
      iconEl.innerHTML = STAGE_ICONS[icon] || STAGE_ICONS.zap;
      // Strip any prior ic-* class, add new one.
      iconEl.className = iconEl.className.replace(/\bic-\w+/g, '').trim() + ` ic-${icon}`;
    }
    el.dataset.iconKey = icon;
  }
  if (typeof title === 'string') {
    const t = el.querySelector('.sg-title');
    if (t) t.textContent = title;
  }
  if (typeof detail === 'string') {
    let d = el.querySelector('.sg-detail');
    if (!d) {
      d = document.createElement('div');
      d.className = 'sg-detail';
      el.querySelector('.sg-body').appendChild(d);
    }
    d.textContent = detail;
  }
  scrollBottom();
}

async function ingestActiveChat() {
  const bar = $('saveSessionBar');
  const btn = $('ssbBtn');
  if (!bar || bar.classList.contains('hidden')) return;
  if (btn.disabled) return;

  btn.disabled = true;
  bar.classList.add('busy');
  const prevLabel = btn.textContent;
  btn.textContent = 'Capturing…';

  const platformName = $('ssbPlatform')?.textContent || 'AI CHAT';
  const sessionTag = $('ssbSub')?.textContent || '';
  addStageGroupHeader(`Ingest · ${platformName} ${sessionTag}`.trim());

  const detectStage = `detect-${Date.now()}`;
  const promptStage = `prompt-${Date.now()}`;
  const waitStage = `wait-${Date.now()}`;
  const captureStage = `capture-${Date.now()}`;
  const distillStage = `distill-${Date.now()}`;

  addStage({ id: detectStage, icon: 'search', title: 'Detecting platform', detail: platformName, state: 'done' });

  // First-time permission grant for this AI chat origin (must run inside
  // the user-gesture click handler, not in background.js).
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      const u = new URL(tab.url);
      const origin = `${u.protocol}//${u.host}/*`;
      const already = await chrome.permissions.contains({ origins: [origin] });
      if (!already) {
        const permStage = `perm-${Date.now()}`;
        addStage({ id: permStage, icon: 'help', title: 'Requesting permission', detail: `one-time grant for ${u.host}`, state: 'in-flight' });
        const granted = await chrome.permissions.request({ origins: [origin] });
        if (!granted) {
          updateStage(permStage, { state: 'error', icon: 'warn', detail: `denied — re-click "Save session" and choose Allow` });
          btn.disabled = false;
          bar.classList.remove('busy');
          btn.textContent = prevLabel;
          return;
        }
        updateStage(permStage, { state: 'done', icon: 'check', detail: `granted for ${u.host}` });
      }
    }
  } catch (permErr) {
    // Non-fatal — proceed; the bg-side check will catch it.
  }

  addStage({ id: promptStage, icon: 'pen', title: 'Injecting summary prompt', detail: 'sending to chatbox + pressing Enter', state: 'in-flight' });

  try {
    setTimeout(() => updateStage(promptStage, { state: 'done', detail: 'prompt sent to host LLM' }), 800);
    addStage({ id: waitStage, icon: 'clock', title: 'Waiting for response', detail: 'polling until text stabilises…', state: 'in-flight' });

    const result = await chrome.runtime.sendMessage({ action: 'ingestActiveChat' });

    if (!result?.success) throw new Error(result?.error || 'capture failed');

    updateStage(waitStage, {
      state: 'done',
      icon: 'clock',
      detail: `response stable · ${result.messageCount || 0} messages on page`,
    });

    addStage({
      id: captureStage,
      icon: 'camera',
      title: 'Captured summary',
      detail: `${result.candidates || 0} candidate memories parsed from structured output`,
      state: (result.candidates || 0) > 0 ? 'done' : 'error',
    });

    const cand = result.candidates || 0;
    const saved = result.saved || 0;
    const updated = result.updated || 0;
    const deduped = result.deduped || 0;

    if (cand > 0) {
      addStage({
        id: distillStage,
        icon: 'brain',
        title: 'Distilled into HIVEMIND',
        detail: `${saved} saved · ${updated} updated · ${deduped} deduped`,
        state: (saved + updated) > 0 ? 'done' : 'error',
      });
      if (Array.isArray(result.rows) && result.rows.length) {
        addMemoryTrace(result.rows);
      }
    } else {
      addStage({
        id: distillStage,
        icon: 'warn',
        title: 'No structured memories parsed',
        detail: 'host LLM response did not match expected schema — raw transcript saved as fallback',
        state: 'error',
      });
      if (result.raw_summary_preview) {
        addStage({
          id: `raw-${Date.now()}`,
          icon: 'file',
          title: 'Raw host response (preview)',
          detail: result.raw_summary_preview,
          state: 'error',
        });
      }
    }

    if (result.open_questions?.length) {
      addStage({
        id: `oq-${Date.now()}`,
        icon: 'help',
        title: `${result.open_questions.length} open questions noted`,
        detail: result.open_questions.slice(0, 3).join(' · '),
        state: 'done',
      });
    }
  } catch (e) {
    updateStage(waitStage, { state: 'error', detail: e.message });
    addStage({
      id: `err-${Date.now()}`,
      icon: 'warn',
      title: 'Ingest failed',
      detail: e.message,
      state: 'error',
    });
  } finally {
    btn.disabled = false;
    bar.classList.remove('busy');
    btn.textContent = prevLabel;
  }
}

// ── Scope pill (Org default | Project) ─────────────────────────────────────

async function refreshScopePill() {
  try {
    const scope = await chrome.runtime.sendMessage({ action: 'getScope' });
    renderScopePill(scope);
  } catch {
    renderScopePill({ kind: 'org' });
  }
}

function renderScopePill(scope) {
  const pill = $('scopePill');
  const label = $('spLabel');
  if (!pill || !label) return;
  if (scope?.kind === 'project' && scope.projectName) {
    pill.classList.add('is-project');
    label.textContent = scope.projectName.length > 22 ? scope.projectName.slice(0, 21) + '…' : scope.projectName;
    pill.title = `Memories are scoped to "${scope.projectName}". Click to switch.`;
  } else {
    pill.classList.remove('is-project');
    label.textContent = 'Org';
    pill.title = 'Memories are org-wide. Click to scope to a project.';
  }
}

async function populateScopeMenu() {
  const container = $('smProjects');
  if (!container) return;
  container.innerHTML = '<div class="sm-empty">Loading projects…</div>';

  const currentScope = await chrome.runtime.sendMessage({ action: 'getScope' });
  const isOrg = currentScope?.kind !== 'project';
  const checkOrg = $('smCheckOrg');
  if (checkOrg) {
    const orgItem = checkOrg.closest('.sm-item');
    if (orgItem) orgItem.classList.toggle('active', isOrg);
  }

  let projects = [];
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'listProjects' });
    projects = Array.isArray(resp?.projects) ? resp.projects : [];
  } catch (e) {
    container.innerHTML = `<div class="sm-empty">Couldn't load — ${escapeHtml(e.message)}</div>`;
    return;
  }

  if (projects.length === 0) {
    container.innerHTML = '<div class="sm-empty">No projects yet. Create one below.</div>';
    return;
  }

  container.innerHTML = projects
    .map((p) => {
      const active = !isOrg && currentScope.projectId === p.id;
      const name = escapeHtml(p.name || p.slug || 'Untitled');
      return `
        <button class="sm-item ${active ? 'active' : ''}" data-scope-kind="project" data-project-id="${p.id}" data-project-name="${name.replace(/"/g, '&quot;')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <span class="sm-name">${name}</span>
          <span class="sm-check">✓</span>
        </button>`;
    })
    .join('');
}

function openCreateProjectModal() {
  // Close menu
  const menu = $('scopeMenu');
  if (menu) menu.classList.add('hidden');

  // Inject modal once.
  let backdrop = document.getElementById('scopeModalBackdrop');
  if (backdrop) backdrop.remove();
  backdrop = document.createElement('div');
  backdrop.id = 'scopeModalBackdrop';
  backdrop.className = 'scope-modal-backdrop';
  backdrop.innerHTML = `
    <div class="scope-modal" role="dialog" aria-modal="true">
      <h3>Create new project</h3>
      <p>Memories saved while this project is selected will be scoped to it.</p>
      <div class="sm-error hidden" id="scopeModalErr"></div>
      <label for="scopeProjName">Project name</label>
      <input id="scopeProjName" type="text" placeholder="e.g. Q3 Research" maxlength="60" />
      <label for="scopeProjSlug">Slug (auto)</label>
      <input id="scopeProjSlug" type="text" placeholder="auto from name" maxlength="40" />
      <div class="sm-actions">
        <button id="scopeProjCancel">Cancel</button>
        <button class="primary" id="scopeProjCreate">Create</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const nameInput = backdrop.querySelector('#scopeProjName');
  const slugInput = backdrop.querySelector('#scopeProjSlug');
  const errEl = backdrop.querySelector('#scopeModalErr');
  const cancelBtn = backdrop.querySelector('#scopeProjCancel');
  const createBtn = backdrop.querySelector('#scopeProjCreate');

  const close = () => backdrop.remove();
  cancelBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });

  // Auto-slug from name.
  nameInput.addEventListener('input', () => {
    if (!slugInput.dataset.touched) {
      slugInput.value = nameInput.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    }
  });
  slugInput.addEventListener('input', () => { slugInput.dataset.touched = '1'; });

  setTimeout(() => nameInput.focus(), 50);

  createBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const slug = (slugInput.value.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)).replace(/^-+|-+$/g, '');
    if (!name || !slug) {
      errEl.textContent = 'Name and slug required.';
      errEl.classList.remove('hidden');
      return;
    }
    createBtn.disabled = true;
    createBtn.textContent = 'Creating…';
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'createProject', name, slug });
      if (resp?.error) throw new Error(resp.error);
      const proj = resp.project || resp;
      // Auto-switch scope to the new project.
      await chrome.runtime.sendMessage({
        action: 'setScope',
        scope: { kind: 'project', projectId: proj.id, projectName: proj.name },
      });
      renderScopePill({ kind: 'project', projectId: proj.id, projectName: proj.name });
      close();
      flashHint(`Scope switched to project "${proj.name}".`);
    } catch (e) {
      errEl.textContent = e.message || 'Create failed.';
      errEl.classList.remove('hidden');
      createBtn.disabled = false;
      createBtn.textContent = 'Create';
    }
  });
}
