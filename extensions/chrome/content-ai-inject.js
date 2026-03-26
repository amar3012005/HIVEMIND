/**
 * HIVEMIND Chrome Extension — AI Platform Content Script
 *
 * Injected into ChatGPT and Claude.ai to:
 * 1. Auto-inject user context (observation prefix) into conversations
 * 2. Auto-save conversation turns to HIVEMIND
 * 3. Show a subtle HIVEMIND indicator
 *
 * Runs on: chatgpt.com, chat.openai.com, claude.ai
 */

(async () => {
  // ── Config ──────────────────────────────────────────────

  const config = await chrome.storage.local.get(['apiKey', 'apiBase']);
  if (!config.apiKey) return; // Extension not configured

  const API_BASE = config.apiBase || 'https://core.hivemind.davinciai.eu:8050';
  const API_KEY = config.apiKey;
  const platform = detectPlatform();

  if (!platform) return;

  console.log(`[HIVEMIND] Active on ${platform}`);

  // ── Inject HIVEMIND Indicator ───────────────────────────

  injectIndicator();

  // ── Fetch User Profile ──────────────────────────────────

  let userProfile = null;
  try {
    const resp = await fetch(`${API_BASE}/api/profile`, {
      headers: { 'X-API-Key': API_KEY },
    });
    if (resp.ok) {
      const data = await resp.json();
      userProfile = data.profile || data;
    }
  } catch {}

  // ── Watch for new messages ──────────────────────────────

  let lastMessageCount = 0;
  const observer = new MutationObserver(debounce(async () => {
    const messages = getMessages(platform);
    if (messages.length > lastMessageCount && messages.length > 0) {
      const newMessages = messages.slice(lastMessageCount);
      lastMessageCount = messages.length;

      // Save new user messages to HIVEMIND
      for (const msg of newMessages) {
        if (msg.role === 'user' && msg.content.length > 20) {
          // Check if it's a question (don't save questions, only facts)
          const isQuestion = /^(what|when|where|who|how|why|do |does |did |is |are |can |could |tell me|show me)/i.test(msg.content.trim());
          const hasMemoryKeywords = /\b(remember|save|my name|i work|i live|i bought|i moved|i changed)\b/i.test(msg.content);

          if (!isQuestion || hasMemoryKeywords) {
            try {
              await fetch(`${API_BASE}/api/memories`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
                body: JSON.stringify({
                  content: `User (${platform}): ${msg.content.slice(0, 2000)}`,
                  title: `${platform} chat: ${msg.content.slice(0, 50)}`,
                  tags: ['browser-extension', `platform:${platform}`, 'conversation'],
                  memory_type: 'event',
                }),
              });
              flashIndicator();
            } catch {}
          }
        }
      }
    }
  }, 2000));

  // Observe the chat container for new messages
  const chatContainer = document.querySelector('main, [role="main"], .conversation-container, .ReactMarkdown');
  if (chatContainer) {
    observer.observe(chatContainer, { childList: true, subtree: true });
  } else {
    // Fallback: observe body
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Platform Detection ──────────────────────────────────

  function detectPlatform() {
    const host = window.location.hostname;
    if (host.includes('chatgpt.com') || host.includes('chat.openai.com')) return 'chatgpt';
    if (host.includes('claude.ai')) return 'claude';
    return null;
  }

  // ── Message Extraction ──────────────────────────────────

  function getMessages(platform) {
    const messages = [];

    if (platform === 'chatgpt') {
      document.querySelectorAll('[data-message-author-role]').forEach(el => {
        const role = el.getAttribute('data-message-author-role');
        const content = el.innerText?.trim();
        if (content) messages.push({ role, content });
      });
    }

    if (platform === 'claude') {
      document.querySelectorAll('[class*="Message"], .font-claude-message, .font-user-message').forEach(el => {
        const isUser = el.classList.toString().includes('user') || el.closest('[class*="human"]');
        const content = el.innerText?.trim();
        if (content) messages.push({ role: isUser ? 'user' : 'assistant', content });
      });
    }

    return messages;
  }

  // ── HIVEMIND Indicator ──────────────────────────────────

  function injectIndicator() {
    const indicator = document.createElement('div');
    indicator.id = 'hivemind-indicator';
    indicator.innerHTML = '🧠';
    indicator.title = 'HIVEMIND memory active';
    indicator.style.cssText = `
      position: fixed;
      bottom: 20px;
      left: 20px;
      width: 32px;
      height: 32px;
      background: rgba(17,125,255,0.1);
      border: 1px solid rgba(17,125,255,0.2);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      z-index: 99999;
      cursor: pointer;
      transition: all 0.3s;
      opacity: 0.6;
    `;
    indicator.addEventListener('mouseenter', () => { indicator.style.opacity = '1'; indicator.style.transform = 'scale(1.1)'; });
    indicator.addEventListener('mouseleave', () => { indicator.style.opacity = '0.6'; indicator.style.transform = 'scale(1)'; });
    indicator.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'getConfig' }, (config) => {
        if (config?.apiKey) {
          // Show quick popup with profile info
          showQuickInfo();
        }
      });
    });
    document.body.appendChild(indicator);
  }

  function flashIndicator() {
    const el = document.getElementById('hivemind-indicator');
    if (!el) return;
    el.style.background = 'rgba(34,197,94,0.2)';
    el.style.borderColor = 'rgba(34,197,94,0.4)';
    setTimeout(() => {
      el.style.background = 'rgba(17,125,255,0.1)';
      el.style.borderColor = 'rgba(17,125,255,0.2)';
    }, 1000);
  }

  function showQuickInfo() {
    let popup = document.getElementById('hivemind-quick-popup');
    if (popup) { popup.remove(); return; }

    popup = document.createElement('div');
    popup.id = 'hivemind-quick-popup';
    popup.style.cssText = `
      position: fixed;
      bottom: 60px;
      left: 20px;
      width: 280px;
      background: white;
      border: 1px solid #e3e0db;
      border-radius: 12px;
      padding: 16px;
      z-index: 99999;
      box-shadow: 0 8px 24px rgba(0,0,0,0.12);
      font-family: -apple-system, sans-serif;
      font-size: 13px;
    `;

    const memCount = userProfile?.memory_count || '?';
    const obsCount = userProfile?.observation_count || '?';
    const staticFacts = userProfile?.cognitive_profile?.static_facts || [];

    popup.innerHTML = `
      <div style="font-weight:700; margin-bottom:8px; color:#0a0a0a;">🧠 HIVEMIND Active</div>
      <div style="color:#525252; font-size:12px; margin-bottom:8px;">
        ${memCount} memories · ${obsCount} observations
      </div>
      ${staticFacts.length > 0 ? `
        <div style="font-size:11px; color:#a3a3a3; margin-bottom:4px;">What I know about you:</div>
        ${staticFacts.slice(0, 3).map(f => `<div style="font-size:11px; color:#525252; padding:2px 0;">🔴 ${f.slice(0, 60)}</div>`).join('')}
      ` : ''}
      <div style="font-size:10px; color:#a3a3a3; margin-top:8px;">🇪🇺 EU Sovereign · Frankfurt</div>
    `;

    document.body.appendChild(popup);
    setTimeout(() => popup.remove(), 5000);
  }

  // ── Utility ─────────────────────────────────────────────

  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }
})();
