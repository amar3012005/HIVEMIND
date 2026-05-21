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
      renderSignedIn();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Sign in with browser';
      appendError(e.message);
    }
  });

  $('newChatBtn').addEventListener('click', () => {
    state.history = [];
    $('messages').innerHTML = '';
    $('input').focus();
  });

  const input = $('input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
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
    const ctx = await chrome.runtime.sendMessage({ action: 'getSelectionContext' });
    if (!ctx) {
      appendError('No text selected on the page. Highlight something first.');
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

  // Section pick broadcast from background → content-script
  chrome.runtime.onMessage.addListener((msg) => {
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
      li.innerHTML = `<span class="step-icon">🔧</span> <code>${escapeHtml(evt.name)}</code> <span class="step-args">${escapeHtml(briefArgs(evt.arguments))}</span> <span class="step-status">…</span>`;
      stepsList.appendChild(li);
    }
    if (evt.type === 'tool_result') {
      const items = stepsList.querySelectorAll('.step-item');
      const last = items[items.length - 1];
      if (last) {
        const status = last.querySelector('.step-status');
        if (status) status.textContent = '→ ' + (evt.summary || 'ok');
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

function appendUser(text) {
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

  wrap.querySelector('.ai-text').innerHTML = escapeHtml(text);

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
