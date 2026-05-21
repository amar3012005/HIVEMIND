/**
 * HIVEMIND Chat Overlay - Content Script
 * 
 * Professional browser chat interface with:
 * - Glass morphism design (inspired by TARA)
 * - DOM context awareness (inspired by Kimi)
 * - Memory recall and auto-save
 * - Action execution (click, fill, navigate)
 */

(function() {
  'use strict';

  // ── Constants ────────────────────────────────────────
  const OVERLAY_WIDTH = 420;
  const ANIMATION_DURATION = 300;
  const CONTEXT_CAPTURE_DELAY = 1000;
  
  // ── State ────────────────────────────────────────────
  let overlayVisible = false;
  let chatHistory = [];
  let currentPageContext = null;
  let isCapturingContext = false;
  let lastUrl = window.location.href;
  
  // ── Initialization ───────────────────────────────────
  function init() {
    // Don't inject on Chrome internal pages
    if (window.location.protocol === 'chrome:' || 
        window.location.protocol === 'chrome-extension:' ||
        window.location.protocol === 'edge:') {
      return;
    }
    
    createOverlayDOM();
    setupKeyboardShortcut();
    setupMessageListener();
    
    // Detect URL changes
    let lastCheck = window.location.href;
    setInterval(() => {
      if (window.location.href !== lastCheck) {
        lastCheck = window.location.href;
        lastUrl = window.location.href;
        if (overlayVisible) {
          capturePageContext();
        }
      }
    }, 1000);
    
    console.log('[HIVEMIND Chat] Initialized');
  }
  
  // ── DOM Creation ─────────────────────────────────────
  function createOverlayDOM() {
    const container = document.createElement('div');
    container.id = 'hivemind-chat-overlay';
    container.className = 'hivemind-hidden';
    container.innerHTML = `
      <div class="hivemind-chat-panel">
        <!-- Header -->
        <div class="hivemind-chat-header">
          <div class="hivemind-chat-header-title">
            <span class="hivemind-icon">🧠</span>
            <span class="hivemind-title">HIVEMIND</span>
          </div>
          <button class="hivemind-close-btn" id="hivemind-close-chat" title="Close (Cmd+Shift+H)">
            ✕
          </button>
        </div>
        
        <!-- Context Status Bar -->
        <div class="hivemind-context-status" id="hivemind-context-status">
          <span class="hivemind-status-icon">⚡</span>
          <span class="hivemind-status-text">Ready</span>
        </div>
        
        <!-- Messages Container -->
        <div class="hivemind-chat-messages" id="hivemind-chat-messages">
          <div class="hivemind-welcome-message">
            <div class="hivemind-welcome-title">Welcome to HIVEMIND</div>
            <div class="hivemind-welcome-text">
              I can see everything on this page and remember what you tell me.
            </div>
            <div class="hivemind-welcome-examples">
              <div class="hivemind-example">Ask about this page</div>
              <div class="hivemind-example">Search memories: "what do you know about X?"</div>
              <div class="hivemind-example">Save: "remember this" or "save this to memory"</div>
              <div class="hivemind-example">Execute: "click the login button"</div>
            </div>
          </div>
        </div>
        
        <!-- Input Area -->
        <div class="hivemind-chat-input-area">
          <div class="hivemind-chat-input-wrapper">
            <textarea 
              id="hivemind-chat-input" 
              class="hivemind-chat-input"
              placeholder="Ask HIVE anything..."
              rows="1"
            ></textarea>
            <button id="hivemind-send-btn" class="hivemind-send-btn" title="Send">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 10l16-6-6 6 6 6-16-6z"/>
              </svg>
            </button>
          </div>
          <div class="hivemind-input-hint">
            Enter to send · Shift+Enter for newline · Esc to close
          </div>
        </div>
      </div>
    `;
    
    document.body.appendChild(container);
    
    // Event listeners
    document.getElementById('hivemind-close-chat').onclick = hideOverlay;
    document.getElementById('hivemind-send-btn').onclick = sendMessage;
    
    const input = document.getElementById('hivemind-chat-input');
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    };
    
    // Auto-resize textarea
    input.oninput = () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    };
  }
  
  // ── Keyboard Shortcut ────────────────────────────────
  function setupKeyboardShortcut() {
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'H') {
        e.preventDefault();
        toggleOverlay();
      }
    });
  }
  
  // ── Message Listener ─────────────────────────────────
  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'toggleChat') {
        toggleOverlay();
        sendResponse({ success: true });
      }
      return true;
    });
  }
  
  // ── Overlay Toggle ───────────────────────────────────
  function toggleOverlay() {
    if (overlayVisible) {
      hideOverlay();
    } else {
      showOverlay();
    }
  }
  
  async function showOverlay() {
    overlayVisible = true;
    const overlay = document.getElementById('hivemind-chat-overlay');
    overlay.classList.remove('hivemind-hidden');
    
    // Focus input
    setTimeout(() => {
      document.getElementById('hivemind-chat-input')?.focus();
    }, ANIMATION_DURATION);
    
    // Capture page context
    if (!currentPageContext || lastUrl !== window.location.href) {
      await capturePageContext();
      lastUrl = window.location.href;
    }
  }
  
  function hideOverlay() {
    overlayVisible = false;
    document.getElementById('hivemind-chat-overlay').classList.add('hivemind-hidden');
  }
  
  // ── Context Capture ──────────────────────────────────
  async function capturePageContext() {
    if (isCapturingContext) return;
    
    isCapturingContext = true;
    updateStatus('⏳ Capturing page context...', 'loading');
    
    try {
      // Request snapshot from background (via CDP)
      const context = await chrome.runtime.sendMessage({
        action: 'captureContext',
        url: window.location.href
      });
      
      if (context && !context.error) {
        currentPageContext = context;
        const elemCount = context.interactiveElements?.length || 0;
        updateStatus(
          `✓ Context ready · ${elemCount} interactive elements`,
          'ready'
        );
      } else {
        updateStatus('⚠ Context capture failed', 'error');
      }
    } catch (err) {
      console.error('[HIVEMIND] Context capture error:', err);
      updateStatus('⚠ Context unavailable', 'error');
    } finally {
      isCapturingContext = false;
    }
  }
  
  function updateStatus(text, state) {
    const statusEl = document.getElementById('hivemind-context-status');
    if (statusEl) {
      statusEl.querySelector('.hivemind-status-text').textContent = text;
      statusEl.className = `hivemind-context-status hivemind-status-${state}`;
    }
  }
  
  // ── Send Message ─────────────────────────────────────
  async function sendMessage() {
    const input = document.getElementById('hivemind-chat-input');
    const message = input.value.trim();
    
    if (!message) return;
    
    addMessage('user', message);
    input.value = '';
    input.style.height = 'auto';
    
    // ── Intercept "save/remember" commands ──────────────
    const savePattern = /\b(save|remember|store|ingest)\b.*\b(page|this|chat|conversation)\b/i;
    if (savePattern.test(message)) {
      // Execute save immediately, then chat
      try {
        await saveCurrentPage();
        addMessage('system', '✓ Page saved to HIVEMIND memory.');
      } catch (saveErr) {
        addMessage('system', `⚠ Could not save: ${saveErr.message}`, { isError: true });
      }
      // Still send to chat for follow-up
      if (message.toLowerCase().includes('just save') || message.toLowerCase().includes('only save')) {
        return; // Don't chat, just saved
      }
    }
    
    const thinkingId = addThinkingMessage();
    try {
      // Capture fresh context if needed
      if (!currentPageContext || lastUrl !== window.location.href) {
        await capturePageContextQuick();
        lastUrl = window.location.href;
      }
      
      const response = await chrome.runtime.sendMessage({
        action: 'chatMessage',
        message: message,
        context: currentPageContext,
        history: chatHistory.slice(-6),
      });
      
      removeMessage(thinkingId);
      
      if (response?.error) {
        addMessage('system', `Error: ${response.error}`, { isError: true });
      } else if (response?.reply) {
        addMessage('assistant', response.reply, {
          sources: response.sources,
          actions: response.actions,
        });
        if (response.actions && response.actions.length > 0) {
          await executeActions(response.actions);
        }
      }
    } catch (err) {
      removeMessage(thinkingId);
      addMessage('system', `Connection error: ${err.message}`, { isError: true });
    }
    
    chatHistory.push({ role: 'user', content: message });
  }
  
  // ── Message UI ───────────────────────────────────────
  function addMessage(role, content, options = {}) {
    const messagesDiv = document.getElementById('hivemind-chat-messages');

    // Remove welcome message if exists
    const welcome = messagesDiv.querySelector('.hivemind-welcome-message');
    if (welcome) welcome.remove();

    const messageEl = document.createElement('div');
    messageEl.className = `hivemind-message hivemind-message-${role}`;
    if (options.isError) messageEl.classList.add('hivemind-message-error');

    // ── Assistant: AI header badge ───────────────────────
    if (role === 'assistant') {
      const header = document.createElement('div');
      header.className = 'hivemind-ai-header';
      header.innerHTML = `
        <div class="hivemind-ai-header-icon">
          <svg viewBox="0 0 10 10"><path d="M5 0l1.5 3.5L10 5 6.5 6.5 5 10 3.5 6.5 0 5l3.5-1.5z"/></svg>
        </div>
        <span>HIVE</span>
        <span style="opacity:0.5">·</span>
        <span style="opacity:0.6">GPT-OSS 120B</span>
      `;
      messageEl.appendChild(header);
    }

    // Main content
    const contentEl = document.createElement('div');
    contentEl.className = 'hivemind-message-content';
    contentEl.textContent = content;
    messageEl.appendChild(contentEl);

    // ── Metadata footer for assistant ────────────────────
    if (role === 'assistant' && (options.sources || options.tokenInfo)) {
      const metaDiv = document.createElement('div');
      metaDiv.className = 'hivemind-message-meta';

      if (options.sources && options.sources.length > 0) {
        const sourcesRow = document.createElement('div');
        sourcesRow.className = 'hivemind-sources-row';
        const sc = options.sources.length;
        sourcesRow.innerHTML = `
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 6h8M2 3h8M2 9h5"/></svg>
          <span>${sc} SOURCE${sc > 1 ? 'S' : ''} USED</span>
          <span class="hivemind-sources-arrow">›</span>
        `;
        metaDiv.appendChild(sourcesRow);
      }

      const tokensRow = document.createElement('div');
      tokensRow.className = 'hivemind-tokens-row';
      const pt = options.promptTokens || Math.round(content.length / 4);
      const ct = options.completionTokens || Math.round(content.length / 3.5);
      const tt = options.totalTokens || (pt + ct);
      tokensRow.innerHTML = `
        <span><span class="hivemind-token-dot prompt"></span>${pt} prompt</span>
        <span><span class="hivemind-token-dot completion"></span>${ct} completion</span>
        <span><span class="hivemind-token-dot total"></span>${tt} total</span>
      `;
      metaDiv.appendChild(tokensRow);

      messageEl.appendChild(metaDiv);
    }

    // Sources badge (legacy fallback)
    if (options.sources && options.sources.length > 0 && !messageEl.querySelector('.hivemind-message-meta')) {
      const sourcesEl = document.createElement('div');
      sourcesEl.className = 'hivemind-message-sources';
      const label = document.createElement('div');
      label.className = 'hivemind-sources-label';
      label.textContent = `📚 ${options.sources.length} sources`;
      sourcesEl.appendChild(label);
      options.sources.slice(0, 3).forEach(source => {
        const sourceItem = document.createElement('div');
        sourceItem.className = 'hivemind-source-item';
        sourceItem.textContent = source.title || source.content.slice(0, 60);
        sourceItem.title = source.content.slice(0, 200);
        sourcesEl.appendChild(sourceItem);
      });
      messageEl.appendChild(sourcesEl);
    }

    // Actions badge
    if (options.actions && options.actions.length > 0) {
      const actionsBadge = document.createElement('div');
      actionsBadge.className = 'hivemind-actions-badge';
      actionsBadge.textContent = `⚡ ${options.actions.length} action${options.actions.length > 1 ? 's' : ''}`;
      messageEl.appendChild(actionsBadge);
    }

    messagesDiv.appendChild(messageEl);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;

    // Add to history
    if (role !== 'system') {
      chatHistory.push({ role, content });
    }

    return messageEl.id = `msg-${Date.now()}`;
  }
  
  function addThinkingMessage() {
    const messagesDiv = document.getElementById('hivemind-chat-messages');
    const messageEl = document.createElement('div');
    const id = `thinking-${Date.now()}`;
    messageEl.id = id;
    messageEl.className = 'hivemind-message hivemind-message-assistant hivemind-message-thinking';
    messageEl.innerHTML = `
      <div class="hivemind-thinking-indicator">
        <span class="hivemind-thinking-dot"></span>
        <span class="hivemind-thinking-dot"></span>
        <span class="hivemind-thinking-dot"></span>
      </div>
    `;
    messagesDiv.appendChild(messageEl);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    return id;
  }
  
  function removeMessage(id) {
    document.getElementById(id)?.remove();
  }
  
  // ── Action Execution ─────────────────────────────────
  async function executeActions(actions) {
    for (const action of actions) {
      try {
        await executeAction(action);
        showActionToast(action, 'success');
      } catch (err) {
        console.error('[HIVEMIND] Action failed:', err);
        showActionToast(action, 'error');
      }
    }
  }
  
  async function executeAction(action) {
    const { type, target, value } = action;
    
    // Request execution from background (via CDP)
    const result = await chrome.runtime.sendMessage({
      action: 'executeAction',
      actionType: type,
      target: target,
      value: value,
    });
    
    if (result?.error) {
      throw new Error(result.error);
    }
    
    return result;
  }
  
  function showActionToast(action, status) {
    const toast = document.createElement('div');
    toast.className = `hivemind-action-toast hivemind-action-toast-${status}`;
    toast.textContent = status === 'success' 
      ? `✓ ${action.type} executed` 
      : `✗ ${action.type} failed`;
    document.body.appendChild(toast);
    
    setTimeout(() => {
      toast.classList.add('hivemind-action-toast-fade');
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }
  
  // ── Quick Context Capture (lightweight, no CDP) ──────
  async function capturePageContextQuick() {
    // Lightweight context: URL + title + first visible text
    const url = window.location.href;
    const title = document.title;
    const mainText = (document.querySelector('main, article, [role="main"], body')?.innerText || '').slice(0, 4000);
    currentPageContext = { url, title, textContent: mainText, timestamp: new Date().toISOString() };
    updateStatus('✓ Context ready', 'ready');
  }

  // ── Save Current Page ────────────────────────────────
  async function saveCurrentPage() {
    try {
      const result = await chrome.runtime.sendMessage({
        action: 'savePage',
        tabId: null, // current tab
      });
      return result;
    } catch (err) {
      console.error('[HIVEMIND] saveCurrentPage failed:', err);
      throw err;
    }
  }
    try {
      const context = currentPageContext;
      const content = `Q: ${userMessage}\nA: ${aiResponse.reply}`;
      const title = `Chat on ${document.title || window.location.hostname}`;
      
      const tags = [
        'browser-chat',
        `platform:${detectPlatform(window.location.hostname)}`,
        `url:${window.location.hostname}`,
      ];
      
      // Add action tag if actions were executed
      if (aiResponse.actions && aiResponse.actions.length > 0) {
        tags.push('action-executed');
        tags.push(`action:${aiResponse.actions[0].type}`);
      }
      
      await chrome.runtime.sendMessage({
        action: 'saveToMemory',
        content: content,
        title: title,
        tags: tags,
        context: {
          url: context?.url,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (err) {
      console.error('[HIVEMIND] Memory save error:', err);
    }
  }
  
  function detectPlatform(hostname) {
    if (hostname.includes('claude.ai')) return 'claude';
    if (hostname.includes('chatgpt.com') || hostname.includes('chat.openai.com')) return 'chatgpt';
    if (hostname.includes('gemini.google.com')) return 'gemini';
    if (hostname.includes('perplexity.ai')) return 'perplexity';
    if (hostname.includes('github.com')) return 'github';
    if (hostname.includes('stackoverflow.com')) return 'stackoverflow';
    return 'web';
  }
  
  // ── Initialize on Load ───────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
