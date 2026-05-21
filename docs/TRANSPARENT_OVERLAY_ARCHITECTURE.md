# Transparent Browser Overlay Architecture
## HIVEMIND + Kimi WebBridge Integration

**Created:** 2026-05-20  
**Purpose:** Transform HIVEMIND Chrome extension into a transparent, see-through chat interface that combines memory intelligence with browser automation

---

## Executive Summary

### What We're Building
A **transparent right-side overlay** for the browser that:
- **Sees everything**: Captures screen context (DOM, accessibility tree, visual snapshot) automatically
- **Talks intelligently**: Acts like "Talk to HIVE" but with full page awareness
- **Automates actions**: Uses Kimi WebBridge to execute browser commands based on AI decisions
- **Remembers everything**: Saves interactions, decisions, and browsing context to HIVEMIND memory

### Key Innovation
Instead of a traditional opaque chat panel, this is a **glass overlay** that:
- Floats above the page content (transparent background with blur)
- Captures the visible page context automatically when user asks questions
- Can automate browser actions via Kimi's CDP-level control
- Saves all interactions and context to HIVEMIND for future recall

---

## Current State Analysis

### 1. **Kimi WebBridge Extension** (Automation Layer)

**Capabilities:**
```javascript
// Navigation & Tab Control
- navigate(url, newTab, group_title)
- find_tab(url, active)
- close_tab(), list_tabs(), close_session()

// DOM Interaction
- click(selector_or_@ref)
- fill(selector, value)
- mouse_click(selector)  // CDP-level precise clicking
- send_keys(keys, repeat)  // "Enter", "Mod+A", "Shift+Tab"
- key_type(text)

// Page Analysis
- snapshot() → accessibility tree with semantic refs (@e1, @e2)
- screenshot(selector, format, quality)
- save_as_pdf(paper_format, landscape, scale)
- evaluate(javascript_code)

// Network
- network(cmd: start/stop/list/detail) → capture HTTP requests/responses

// File Handling
- upload(selector, files[])
```

**Architecture:**
- Background service worker
- Communicates with local daemon via WebSocket (ws://127.0.0.1:10086/ws)
- Uses Chrome Debugger Protocol (CDP) for deep browser control
- Tool-based message system: `tool_call` → `tool_result`

**Key Insight:** Kimi provides **programmatic browser control** that HIVEMIND AI can use to execute actions.

---

### 2. **HIVEMIND Chrome Extension** (Memory Layer)

**Capabilities:**
```javascript
// Memory Operations
- saveToHivemind(content, title, tags, source)
- recallFromHivemind(query, max_memories)
- getProfile() → user context

// Platform Extractors
- detectPlatform() → chatgpt|claude|gemini|perplexity|github|generic
- extractChatGPT() → conversation with messages
- extractClaude() → conversation with messages
- extractGemini() → conversation with messages
- extractPerplexity() → Q&A with sources
- extractGitHub() → code, issues, PRs
- extractArticle() → clean markdown

// Auto-Capture
- Content script monitors AI platforms (ChatGPT, Claude)
- Auto-saves user messages to memory
- Filters questions vs statements (saves facts, not queries)
```

**Architecture:**
- Background service worker
- Content scripts injected into AI platforms
- API client: `core.hivemind.davinciai.eu:8050`
- Context menu: "Save to HIVEMIND" for selections/pages
- Storage: API key, base URL, user ID

**Key Insight:** HIVEMIND provides **perfect memory** but no screen awareness or automation.

---

### 3. **Talk to HIVE** (Chat Interface — React Component)

**Capabilities:**
```javascript
// Chat Features
- Natural language queries to memory
- AI-generated answers with source attribution
- Shows which memories were used (with scores)
- Model selection (Groq: GPT-OSS 120B, Llama 3.3 70B)
- Token usage tracking
- 2000 char limit per message
- History maintained (last 10 messages)

// UI/UX
- Slide-out panel from right (420px width)
- Glass morphism design (blur + transparency)
- Keyboard shortcuts: Enter to send, Shift+Enter for newline, Esc to close
- Auto-resize textarea
- Empty state with suggested prompts
```

**API Endpoint:**
```javascript
POST /v1/proxy/chat
Body: {
  message: string,
  model: string,
  history: Array<{role, content}>
}

Response: {
  response: string,
  sources: Array<{title, content, score}>,
  usage: {prompt_tokens, completion_tokens}
}
```

**Key Insight:** Talk to HIVE is **memory-only** — no page context awareness.

---

### 4. **TARA Visual Co-Pilot Widget** (Overlay Pattern)

**Capabilities:**
```javascript
// Overlay Features
- Transparent glass container with backdrop-filter blur
- Voice activity detection (VAD)
- Audio streaming (mic → backend)
- DOM collection and streaming
- Ghost cursor for AI-controlled clicks
- Mission state persistence across navigations
- WebSocket connection to backend
```

**UI Pattern:**
```css
/* Glass overlay with transparency */
.overlay {
  backdrop-filter: blur(12px);
  background: rgba(255, 255, 255, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.3);
}
```

**Key Insight:** TARA shows how to create a **non-intrusive transparent overlay** that captures context.

---

## Proposed Architecture: **HIVEMIND Glass Overlay**

### Design Philosophy

> **"Invisible until needed, intelligent when engaged, actionable after answering."**

The overlay is:
1. **Context-aware**: Automatically captures page DOM, accessibility tree, visible text
2. **Memory-powered**: Answers using HIVEMIND recall (personal + page context)
3. **Action-capable**: Can execute browser automation via Kimi WebBridge
4. **Transparent**: Glass morphism design that doesn't block page content

---

## Component Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  HIVEMIND Glass Overlay (Content Script)                    │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Transparent Chat Panel (right-side, 380px)          │  │
│  │  ┌─────────────────────────────────────────────────┐ │  │
│  │  │  1. Context Capture Engine                      │ │  │
│  │  │     - DOM snapshot (via Kimi)                   │ │  │
│  │  │     - Accessibility tree                        │ │  │
│  │  │     - Visible text extraction                   │ │  │
│  │  │     - Screenshot (optional)                     │ │  │
│  │  └─────────────────────────────────────────────────┘ │  │
│  │  ┌─────────────────────────────────────────────────┐ │  │
│  │  │  2. Query Engine                                │ │  │
│  │  │     - Combines: user query + page context +     │ │  │
│  │  │       HIVEMIND memory recall                    │ │  │
│  │  │     - API: POST /v1/proxy/chat-with-context     │ │  │
│  │  └─────────────────────────────────────────────────┘ │  │
│  │  ┌─────────────────────────────────────────────────┐ │  │
│  │  │  3. Action Executor                             │ │  │
│  │  │     - Parses AI response for actions            │ │  │
│  │  │     - Executes via Kimi: click, fill, navigate  │ │  │
│  │  │     - Shows visual feedback (ghost cursor)      │ │  │
│  │  └─────────────────────────────────────────────────┘ │  │
│  │  ┌─────────────────────────────────────────────────┐ │  │
│  │  │  4. Memory Saver                                │ │  │
│  │  │     - Auto-saves Q&A to HIVEMIND                │ │  │
│  │  │     - Tags: page URL, timestamp, action taken   │ │  │
│  │  └─────────────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## User Flow

### 1. Activation
```
User presses: Cmd/Ctrl + Shift + H
OR clicks extension icon
→ Transparent overlay slides in from right
→ Auto-captures current page context in background
```

### 2. Query with Context
```
User types: "What's the price of the first item?"

System does:
1. Capture page DOM via Kimi's snapshot()
2. Extract visible product listings
3. Query HIVEMIND: "user asked about price + [page context]"
4. Combine: memory recall + page analysis
5. Respond: "The first item (Sony WH-1000XM5) is $349.99"
```

### 3. Execute Actions
```
User types: "Add it to cart"

System does:
1. Parse intent: "add_to_cart"
2. Find target: Kimi's snapshot() → @e15 (button with "Add to Cart")
3. Execute: chrome.runtime.sendMessage({action: 'kimiTool', tool: 'click', args: {selector: '@e15'}})
4. Verify: Check DOM change
5. Save to memory: "User added Sony WH-1000XM5 to cart on amazon.com"
6. Respond: "✓ Added to cart"
```

### 4. Memory Persistence
```
Every interaction auto-saved:
{
  content: "Q: What's the price of the first item?\nA: Sony WH-1000XM5 is $349.99\nAction: Added to cart",
  title: "Shopping query on amazon.com",
  tags: ["browser-assistant", "e-commerce", "url:amazon.com/s?k=headphones", "action:add-to-cart"],
  source: "browser-glass-overlay",
  timestamp: "2026-05-20T14:23:45Z"
}
```

---

## Technical Implementation

### File Structure
```
/Users/amar/HIVE-MIND/extensions/chrome/
├── manifest.json (updated with new permissions)
├── background.js (route messages between components)
├── glass-overlay-inject.js (NEW - main overlay script)
├── glass-overlay.html (NEW - transparent UI template)
├── glass-overlay.css (NEW - glass morphism styles)
├── context-capture.js (NEW - DOM/accessibility snapshot)
├── action-executor.js (NEW - Kimi tool executor)
├── extractors.js (existing - platform-specific content)
└── icons/ (NEW - overlay icons)
```

### Key Code Modules

#### 1. **glass-overlay-inject.js** (Main Entry Point)

```javascript
/**
 * HIVEMIND Glass Overlay — Transparent Browser Assistant
 * 
 * Combines:
 * - Kimi WebBridge (browser automation)
 * - HIVEMIND (memory & recall)
 * - Glass UI (transparent, non-intrusive)
 * 
 * Activation: Cmd+Shift+H or click extension icon
 */

(function() {
  'use strict';

  // ── State ────────────────────────────────────────────────
  let overlayVisible = false;
  let currentPageContext = null;
  let chatHistory = [];
  
  // ── Configuration ────────────────────────────────────────
  const CONFIG = {
    overlayWidth: '380px',
    position: 'right', // 'right' or 'left'
    captureContextOnOpen: true,
    autoSaveInteractions: true,
    kimiEnabled: false, // Will be detected at runtime
    apiBase: 'https://core.hivemind.davinciai.eu:8050',
  };

  // ── Initialization ───────────────────────────────────────
  async function init() {
    // Check if Kimi WebBridge is available
    CONFIG.kimiEnabled = await checkKimiAvailability();
    
    // Load user config from storage
    const stored = await chrome.storage.local.get(['apiKey', 'apiBase']);
    if (stored.apiKey) CONFIG.apiKey = stored.apiKey;
    if (stored.apiBase) CONFIG.apiBase = stored.apiBase;
    
    // Create overlay DOM
    createOverlayDOM();
    
    // Setup keyboard shortcut
    document.addEventListener('keydown', handleKeyboardShortcut);
    
    // Listen for extension icon click
    chrome.runtime.onMessage.addListener(handleMessage);
    
    console.log('[HIVEMIND Glass] Initialized', { kimiEnabled: CONFIG.kimiEnabled });
  }

  // ── Kimi Availability Check ──────────────────────────────
  async function checkKimiAvailability() {
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'checkKimi'
      });
      return response?.available === true;
    } catch {
      return false;
    }
  }

  // ── Overlay DOM Creation ─────────────────────────────────
  function createOverlayDOM() {
    const container = document.createElement('div');
    container.id = 'hivemind-glass-overlay';
    container.className = 'hivemind-glass-hidden';
    
    container.innerHTML = `
      <div class="glass-panel">
        <!-- Header -->
        <div class="glass-header">
          <div class="header-left">
            <div class="brain-icon">🧠</div>
            <div>
              <div class="header-title">HIVEMIND</div>
              <div class="header-subtitle">Memory + Browser AI</div>
            </div>
          </div>
          <button class="close-btn" data-action="close">✕</button>
        </div>
        
        <!-- Context Status -->
        <div class="context-status" id="context-status">
          <span class="context-icon">📄</span>
          <span class="context-text">Capturing page context...</span>
        </div>
        
        <!-- Chat Messages -->
        <div class="chat-messages" id="chat-messages">
          <div class="empty-state">
            <div class="empty-icon">💬</div>
            <div class="empty-title">Ask me anything</div>
            <div class="empty-subtitle">
              I can see this page and recall your memories
            </div>
            <div class="suggested-prompts">
              <button class="prompt-chip">What's on this page?</button>
              <button class="prompt-chip">Summarize this article</button>
              <button class="prompt-chip">What did I save about this topic?</button>
            </div>
          </div>
        </div>
        
        <!-- Input Area -->
        <div class="chat-input-container">
          <textarea 
            id="chat-input" 
            placeholder="Ask about this page or your memories..."
            rows="1"
          ></textarea>
          <button class="send-btn" data-action="send">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M15 8L1 1v6l10 1L1 9v6z"/>
            </svg>
          </button>
        </div>
        
        <!-- Footer Stats -->
        <div class="glass-footer">
          <span class="footer-stat" id="kimi-status">
            ${CONFIG.kimiEnabled ? '✓ Automation ready' : '○ Automation unavailable'}
          </span>
          <span class="footer-stat">Esc to close</span>
        </div>
      </div>
    `;
    
    document.body.appendChild(container);
    attachEventListeners();
  }

  // ── Event Listeners ──────────────────────────────────────
  function attachEventListeners() {
    const overlay = document.getElementById('hivemind-glass-overlay');
    
    // Close button
    overlay.querySelector('[data-action="close"]').addEventListener('click', hideOverlay);
    
    // Send button
    overlay.querySelector('[data-action="send"]').addEventListener('click', handleSendMessage);
    
    // Input field
    const input = overlay.querySelector('#chat-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendMessage();
      }
    });
    
    // Auto-resize textarea
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
    
    // Suggested prompts
    overlay.querySelectorAll('.prompt-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        input.value = chip.textContent;
        handleSendMessage();
      });
    });
    
    // Click outside to close
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) hideOverlay();
    });
  }

  // ── Keyboard Shortcut ────────────────────────────────────
  function handleKeyboardShortcut(e) {
    // Cmd+Shift+H (Mac) or Ctrl+Shift+H (Win/Linux)
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'H') {
      e.preventDefault();
      toggleOverlay();
    }
    
    // Escape to close
    if (e.key === 'Escape' && overlayVisible) {
      hideOverlay();
    }
  }

  // ── Message Handler ──────────────────────────────────────
  function handleMessage(message, sender, sendResponse) {
    if (message.action === 'toggleOverlay') {
      toggleOverlay();
      sendResponse({ success: true });
    }
    return true;
  }

  // ── Overlay Toggle ───────────────────────────────────────
  async function toggleOverlay() {
    if (overlayVisible) {
      hideOverlay();
    } else {
      await showOverlay();
    }
  }

  async function showOverlay() {
    overlayVisible = true;
    const overlay = document.getElementById('hivemind-glass-overlay');
    overlay.classList.remove('hivemind-glass-hidden');
    
    // Auto-focus input
    setTimeout(() => {
      overlay.querySelector('#chat-input').focus();
    }, 300);
    
    // Capture page context if enabled
    if (CONFIG.captureContextOnOpen) {
      await capturePageContext();
    }
  }

  function hideOverlay() {
    overlayVisible = false;
    const overlay = document.getElementById('hivemind-glass-overlay');
    overlay.classList.add('hivemind-glass-hidden');
  }

  // ── Context Capture ──────────────────────────────────────
  async function capturePageContext() {
    const statusEl = document.getElementById('context-status');
    statusEl.innerHTML = '<span class="context-icon spinning">⟳</span><span class="context-text">Capturing page context...</span>';
    
    try {
      const context = {
        url: window.location.href,
        title: document.title,
        timestamp: new Date().toISOString(),
        platform: detectPlatform(window.location.hostname),
      };
      
      // Get visible text
      context.visibleText = extractVisibleText();
      
      // Get Kimi snapshot if available
      if (CONFIG.kimiEnabled) {
        const snapshot = await executeKimiTool('snapshot', {});
        if (snapshot?.tree) {
          context.accessibilityTree = snapshot.tree;
          context.interactiveElements = extractInteractiveElements(snapshot.tree);
        }
      }
      
      // Get smart extraction based on platform
      const extracted = await chrome.runtime.sendMessage({
        action: 'extractPage'
      });
      if (extracted?.content) {
        context.extracted = extracted;
      }
      
      currentPageContext = context;
      
      statusEl.innerHTML = `
        <span class="context-icon">✓</span>
        <span class="context-text">Page context ready · ${context.interactiveElements?.length || 0} interactive elements</span>
      `;
      
      console.log('[HIVEMIND Glass] Context captured:', context);
    } catch (err) {
      console.error('[HIVEMIND Glass] Context capture failed:', err);
      statusEl.innerHTML = '<span class="context-icon">⚠</span><span class="context-text">Context capture failed</span>';
    }
  }

  // ── Text Extraction ──────────────────────────────────────
  function extractVisibleText() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          
          const style = window.getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return NodeFilter.FILTER_REJECT;
          }
          
          const text = node.textContent.trim();
          return text.length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      }
    );
    
    const texts = [];
    let node;
    while (node = walker.nextNode()) {
      texts.push(node.textContent.trim());
    }
    
    return texts.join(' ').slice(0, 4000); // Limit to 4000 chars
  }

  // ── Interactive Elements Extraction ──────────────────────
  function extractInteractiveElements(tree) {
    const elements = [];
    const interactiveRoles = ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'menuitem', 'tab'];
    
    function traverse(node) {
      if (node.role && interactiveRoles.includes(node.role) && node.ref) {
        elements.push({
          ref: node.ref,
          role: node.role,
          name: node.name,
          value: node.value,
        });
      }
      if (node.children) {
        node.children.forEach(traverse);
      }
    }
    
    tree.forEach(traverse);
    return elements;
  }

  // ── Platform Detection ───────────────────────────────────
  function detectPlatform(hostname) {
    if (hostname.includes('github.com')) return 'github';
    if (hostname.includes('stackoverflow.com')) return 'stackoverflow';
    if (hostname.includes('amazon.com')) return 'amazon';
    if (hostname.includes('youtube.com')) return 'youtube';
    if (hostname.includes('twitter.com') || hostname.includes('x.com')) return 'twitter';
    if (hostname.includes('linkedin.com')) return 'linkedin';
    if (hostname.includes('chatgpt.com')) return 'chatgpt';
    if (hostname.includes('claude.ai')) return 'claude';
    return 'generic';
  }

  // ── Send Message Handler ─────────────────────────────────
  async function handleSendMessage() {
    const input = document.querySelector('#chat-input');
    const message = input.value.trim();
    if (!message) return;
    
    // Clear input
    input.value = '';
    input.style.height = 'auto';
    
    // Add user message to UI
    addMessageToUI('user', message);
    
    // Show thinking indicator
    const thinkingId = addMessageToUI('assistant', '...', { thinking: true });
    
    try {
      // Query with context
      const response = await queryWithContext(message);
      
      // Remove thinking indicator
      removeMessageFromUI(thinkingId);
      
      // Add assistant response
      addMessageToUI('assistant', response.answer, {
        sources: response.sources,
        actions: response.actions,
      });
      
      // Execute actions if any
      if (response.actions && response.actions.length > 0) {
        await executeActions(response.actions);
      }
      
      // Save to memory if enabled
      if (CONFIG.autoSaveInteractions) {
        await saveInteractionToMemory(message, response);
      }
      
    } catch (err) {
      removeMessageFromUI(thinkingId);
      addMessageToUI('assistant', `Error: ${err.message}`, { error: true });
    }
  }

  // ── Query with Context ───────────────────────────────────
  async function queryWithContext(userMessage) {
    const payload = {
      message: userMessage,
      context: currentPageContext,
      history: chatHistory.slice(-6), // Last 6 messages for context
    };
    
    const response = await fetch(`${CONFIG.apiBase}/api/chat-with-context`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': CONFIG.apiKey,
      },
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    
    const data = await response.json();
    return data;
  }

  // ── UI Message Management ────────────────────────────────
  function addMessageToUI(role, content, options = {}) {
    const messagesContainer = document.getElementById('chat-messages');
    const emptyState = messagesContainer.querySelector('.empty-state');
    if (emptyState) emptyState.remove();
    
    const messageId = `msg-${Date.now()}`;
    const messageEl = document.createElement('div');
    messageEl.id = messageId;
    messageEl.className = `chat-message ${role}-message ${options.thinking ? 'thinking' : ''} ${options.error ? 'error' : ''}`;
    
    if (role === 'user') {
      messageEl.innerHTML = `
        <div class="message-content">${escapeHtml(content)}</div>
      `;
    } else {
      messageEl.innerHTML = `
        <div class="assistant-header">
          <span class="assistant-icon">🧠</span>
          <span class="assistant-label">HIVEMIND</span>
        </div>
        <div class="message-content">${escapeHtml(content)}</div>
        ${options.sources ? renderSources(options.sources) : ''}
        ${options.actions ? renderActions(options.actions) : ''}
      `;
    }
    
    messagesContainer.appendChild(messageEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    
    // Add to history
    if (!options.thinking) {
      chatHistory.push({ role, content });
    }
    
    return messageId;
  }

  function removeMessageFromUI(messageId) {
    document.getElementById(messageId)?.remove();
  }

  function renderSources(sources) {
    if (!sources || sources.length === 0) return '';
    return `
      <div class="message-sources">
        <div class="sources-header">📚 ${sources.length} source${sources.length > 1 ? 's' : ''}</div>
        ${sources.map(s => `
          <div class="source-item">
            <div class="source-title">${escapeHtml(s.title)}</div>
            ${s.score ? `<div class="source-score">score: ${s.score.toFixed(3)}</div>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderActions(actions) {
    if (!actions || actions.length === 0) return '';
    return `
      <div class="message-actions">
        <div class="actions-header">⚡ ${actions.length} action${actions.length > 1 ? 's' : ''} executed</div>
        ${actions.map(a => `
          <div class="action-item">
            <span class="action-type">${a.type}</span>
            <span class="action-target">${a.target || ''}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ── Action Execution ─────────────────────────────────────
  async function executeActions(actions) {
    for (const action of actions) {
      try {
        await executeKimiTool(action.tool, action.args);
        console.log('[HIVEMIND Glass] Executed action:', action);
      } catch (err) {
        console.error('[HIVEMIND Glass] Action failed:', action, err);
      }
    }
  }

  // ── Kimi Tool Executor ───────────────────────────────────
  async function executeKimiTool(toolName, args) {
    const response = await chrome.runtime.sendMessage({
      action: 'kimiTool',
      tool: toolName,
      args: args,
    });
    
    if (response.error) {
      throw new Error(response.error);
    }
    
    return response.data;
  }

  // ── Memory Saver ─────────────────────────────────────────
  async function saveInteractionToMemory(userMessage, aiResponse) {
    try {
      await chrome.runtime.sendMessage({
        action: 'saveText',
        content: `Q: ${userMessage}\nA: ${aiResponse.answer}`,
        title: `Browser assistant on ${currentPageContext?.title || window.location.hostname}`,
        tags: [
          'browser-glass-overlay',
          `platform:${currentPageContext?.platform || 'generic'}`,
          `url:${window.location.hostname}`,
          ...(aiResponse.actions?.length > 0 ? ['action-taken'] : []),
        ],
      });
    } catch (err) {
      console.error('[HIVEMIND Glass] Failed to save interaction:', err);
    }
  }

  // ── Initialize on Load ───────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
```

---

#### 2. **glass-overlay.css** (Transparent Glass Styling)

```css
/* HIVEMIND Glass Overlay — Transparent Browser Assistant */

#hivemind-glass-overlay {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 100%;
  z-index: 2147483647; /* Maximum z-index */
  font-family: 'Space Grotesk', system-ui, -apple-system, sans-serif;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.25s ease-out;
}

#hivemind-glass-overlay:not(.hivemind-glass-hidden) {
  opacity: 1;
  pointer-events: auto;
}

.hivemind-glass-hidden {
  opacity: 0 !important;
  pointer-events: none !important;
}

/* Glass Panel */
.glass-panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 380px;
  display: flex;
  flex-direction: column;
  
  /* Glass morphism effect */
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  
  /* Border and shadow */
  border-left: 1px solid rgba(255, 255, 255, 0.5);
  box-shadow: -8px 0 32px rgba(0, 0, 0, 0.08), 
              -2px 0 8px rgba(0, 0, 0, 0.04);
  
  /* Animation */
  transform: translateX(100%);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

#hivemind-glass-overlay:not(.hivemind-glass-hidden) .glass-panel {
  transform: translateX(0);
}

/* Header */
.glass-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  background: rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid rgba(227, 224, 219, 0.5);
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.brain-icon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  background: rgba(17, 125, 255, 0.08);
  border: 1px solid rgba(17, 125, 255, 0.15);
  border-radius: 8px;
}

.header-title {
  font-size: 14px;
  font-weight: 700;
  color: #0a0a0a;
  letter-spacing: -0.01em;
}

.header-subtitle {
  font-size: 10px;
  color: #a3a3a3;
  font-family: 'Courier New', monospace;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.close-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: #a3a3a3;
  cursor: pointer;
  border-radius: 6px;
  transition: all 0.15s ease;
}

.close-btn:hover {
  background: rgba(0, 0, 0, 0.05);
  color: #0a0a0a;
}

/* Context Status */
.context-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: rgba(17, 125, 255, 0.04);
  border-bottom: 1px solid rgba(227, 224, 219, 0.5);
  font-size: 11px;
  color: #525252;
  flex-shrink: 0;
}

.context-icon {
  font-size: 12px;
}

.context-icon.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.context-text {
  flex: 1;
  font-family: 'Courier New', monospace;
}

/* Chat Messages */
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.chat-messages::-webkit-scrollbar {
  width: 6px;
}

.chat-messages::-webkit-scrollbar-track {
  background: transparent;
}

.chat-messages::-webkit-scrollbar-thumb {
  background: rgba(163, 163, 163, 0.3);
  border-radius: 3px;
}

.chat-messages::-webkit-scrollbar-thumb:hover {
  background: rgba(163, 163, 163, 0.5);
}

/* Empty State */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 40px 20px;
  gap: 16px;
}

.empty-icon {
  font-size: 48px;
  opacity: 0.5;
}

.empty-title {
  font-size: 16px;
  font-weight: 700;
  color: #0a0a0a;
}

.empty-subtitle {
  font-size: 13px;
  color: #a3a3a3;
  max-width: 280px;
  line-height: 1.5;
}

.suggested-prompts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  max-width: 300px;
}

.prompt-chip {
  padding: 10px 14px;
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid rgba(227, 224, 219, 0.8);
  border-radius: 10px;
  font-size: 12px;
  color: #525252;
  cursor: pointer;
  transition: all 0.15s ease;
  text-align: left;
}

.prompt-chip:hover {
  background: rgba(17, 125, 255, 0.05);
  border-color: rgba(17, 125, 255, 0.3);
  color: #117dff;
}

/* Message Bubbles */
.chat-message {
  display: flex;
  flex-direction: column;
  gap: 6px;
  animation: slideUp 0.25s ease-out;
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.user-message {
  align-items: flex-end;
}

.user-message .message-content {
  background: #117dff;
  color: white;
  padding: 12px 16px;
  border-radius: 16px 16px 4px 16px;
  max-width: 85%;
  font-size: 13px;
  line-height: 1.5;
  word-wrap: break-word;
  box-shadow: 0 2px 8px rgba(17, 125, 255, 0.15);
}

.assistant-message {
  align-items: flex-start;
}

.assistant-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-left: 4px;
  margin-bottom: 4px;
}

.assistant-icon {
  font-size: 14px;
}

.assistant-label {
  font-size: 10px;
  font-family: 'Courier New', monospace;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #a3a3a3;
}

.assistant-message .message-content {
  background: rgba(255, 255, 255, 0.95);
  border: 1px solid rgba(227, 224, 219, 0.8);
  color: #0a0a0a;
  padding: 12px 16px;
  border-radius: 16px 16px 16px 4px;
  max-width: 90%;
  font-size: 13px;
  line-height: 1.6;
  word-wrap: break-word;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.assistant-message.thinking .message-content {
  opacity: 0.6;
}

.assistant-message.error .message-content {
  background: rgba(239, 68, 68, 0.05);
  border-color: rgba(239, 68, 68, 0.3);
  color: #dc2626;
}

/* Sources */
.message-sources {
  margin-top: 10px;
  padding: 10px;
  background: rgba(250, 249, 244, 0.9);
  border: 1px solid rgba(227, 224, 219, 0.6);
  border-radius: 10px;
  font-size: 11px;
}

.sources-header {
  font-family: 'Courier New', monospace;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #a3a3a3;
  margin-bottom: 8px;
  font-size: 10px;
}

.source-item {
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.8);
  border-radius: 6px;
  margin-bottom: 4px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.source-title {
  flex: 1;
  color: #0a0a0a;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-score {
  font-family: 'Courier New', monospace;
  color: #a3a3a3;
  font-size: 10px;
}

/* Actions */
.message-actions {
  margin-top: 10px;
  padding: 10px;
  background: rgba(22, 163, 74, 0.05);
  border: 1px solid rgba(22, 163, 74, 0.2);
  border-radius: 10px;
  font-size: 11px;
}

.actions-header {
  font-family: 'Courier New', monospace;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #16a34a;
  margin-bottom: 8px;
  font-size: 10px;
}

.action-item {
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.8);
  border-radius: 6px;
  margin-bottom: 4px;
  display: flex;
  gap: 8px;
}

.action-type {
  font-family: 'Courier New', monospace;
  color: #16a34a;
  font-weight: 600;
}

.action-target {
  color: #525252;
}

/* Input Area */
.chat-input-container {
  flex-shrink: 0;
  padding: 14px 16px;
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(10px);
  border-top: 1px solid rgba(227, 224, 219, 0.5);
  display: flex;
  gap: 10px;
  align-items: flex-end;
}

#chat-input {
  flex: 1;
  min-height: 40px;
  max-height: 120px;
  padding: 10px 14px;
  background: rgba(250, 249, 244, 0.9);
  border: 1px solid rgba(227, 224, 219, 0.8);
  border-radius: 12px;
  font-size: 13px;
  color: #0a0a0a;
  resize: none;
  outline: none;
  font-family: 'Space Grotesk', system-ui, -apple-system, sans-serif;
  line-height: 1.5;
  transition: all 0.15s ease;
}

#chat-input:focus {
  border-color: rgba(17, 125, 255, 0.4);
  background: rgba(255, 255, 255, 0.95);
}

#chat-input::placeholder {
  color: #c4c1bb;
}

.send-btn {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #117dff;
  color: white;
  border: none;
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.send-btn:hover {
  background: #0066e0;
  transform: scale(1.05);
}

.send-btn:active {
  transform: scale(0.95);
}

/* Footer */
.glass-footer {
  flex-shrink: 0;
  padding: 10px 16px;
  background: rgba(250, 249, 244, 0.9);
  backdrop-filter: blur(10px);
  border-top: 1px solid rgba(227, 224, 219, 0.5);
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 10px;
  font-family: 'Courier New', monospace;
  color: #a3a3a3;
}

.footer-stat {
  display: flex;
  align-items: center;
  gap: 4px;
}
```

---

#### 3. **manifest.json** (Updated Permissions)

```json
{
  "manifest_version": 3,
  "name": "HIVEMIND Glass — AI Memory + Browser Automation",
  "version": "2.0.0",
  "description": "Transparent browser assistant with perfect memory and automation. See-through overlay with context-aware AI.",
  "permissions": [
    "activeTab",
    "storage",
    "contextMenus",
    "scripting",
    "tabs"
  ],
  "host_permissions": [
    "https://core.hivemind.davinciai.eu:8050/*",
    "https://api.hivemind.davinciai.eu:8040/*",
    "<all_urls>"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "32": "icons/icon32.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["glass-overlay-inject.js"],
      "css": ["glass-overlay.css"],
      "run_at": "document_idle",
      "all_frames": false
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["extractors.js", "icons/*"],
      "matches": ["<all_urls>"]
    }
  ],
  "commands": {
    "toggle-overlay": {
      "suggested_key": {
        "default": "Ctrl+Shift+H",
        "mac": "Command+Shift+H"
      },
      "description": "Toggle HIVEMIND Glass Overlay"
    }
  }
}
```

---

#### 4. **background.js** (Updated Message Router)

```javascript
/**
 * HIVEMIND Glass Overlay — Background Service Worker
 * 
 * Routes messages between:
 * - Content script (glass-overlay-inject.js)
 * - Kimi WebBridge extension
 * - HIVEMIND API
 */

// ── Kimi WebBridge Integration ──────────────────────────────

async function checkKimiAvailability() {
  try {
    // Check if Kimi extension is installed by looking for its ID
    const KIMI_EXTENSION_ID = 'your-kimi-extension-id-here'; // TODO: Replace with actual ID
    const response = await chrome.runtime.sendMessage(KIMI_EXTENSION_ID, {
      type: 'GET_STATUS'
    });
    return response?.connected === true;
  } catch {
    return false;
  }
}

async function executeKimiTool(toolName, args) {
  const KIMI_EXTENSION_ID = 'your-kimi-extension-id-here';
  
  try {
    // Send tool execution request to Kimi
    const response = await chrome.runtime.sendMessage(KIMI_EXTENSION_ID, {
      type: 'EXECUTE_TOOL',
      tool: toolName,
      args: args,
    });
    
    if (response.error) {
      throw new Error(response.error);
    }
    
    return response.data;
  } catch (err) {
    throw new Error(`Kimi tool failed: ${err.message}`);
  }
}

// ── HIVEMIND API Integration ─────────────────────────────────

async function getConfig() {
  const result = await chrome.storage.local.get(['apiKey', 'apiBase', 'userId']);
  return {
    apiKey: result.apiKey || '',
    apiBase: result.apiBase || 'https://core.hivemind.davinciai.eu:8050',
    userId: result.userId || '',
  };
}

async function saveToHivemind(config, memory) {
  try {
    const resp = await fetch(`${config.apiBase}/api/memories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.apiKey,
      },
      body: JSON.stringify({
        content: memory.content.slice(0, 8000),
        title: memory.title,
        tags: memory.tags,
        memory_type: 'fact',
        source_metadata: {
          source_type: 'browser-glass-overlay',
          source_platform: memory.source || 'browser',
        },
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      return { success: false, error: err.slice(0, 200) };
    }

    const data = await resp.json();
    return { success: true, memoryId: data.memory?.id };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function recallFromHivemind(config, query) {
  try {
    const resp = await fetch(`${config.apiBase}/api/recall`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.apiKey,
      },
      body: JSON.stringify({
        query_context: query,
        max_memories: 5,
      }),
    });

    if (!resp.ok) return { memories: [], injectionText: '' };
    const data = await resp.json();
    return {
      memories: data.memories || [],
      injectionText: data.injectionText || '',
    };
  } catch {
    return { memories: [], injectionText: '' };
  }
}

// ── Message Handler ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Check Kimi availability
  if (message.action === 'checkKimi') {
    checkKimiAvailability().then(available => {
      sendResponse({ available });
    });
    return true;
  }

  // Execute Kimi tool
  if (message.action === 'kimiTool') {
    executeKimiTool(message.tool, message.args).then(data => {
      sendResponse({ data });
    }).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  // Extract page content
  if (message.action === 'extractPage') {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      files: ['extractors.js']
    }).then(() => {
      return chrome.scripting.executeScript({
        target: { tabId: sender.tab.id },
        func: () => smartExtract()
      });
    }).then(results => {
      sendResponse(results[0]?.result);
    }).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  // Save to memory
  if (message.action === 'saveText') {
    getConfig().then(config => {
      return saveToHivemind(config, {
        content: message.content,
        title: message.title || 'Saved from glass overlay',
        tags: message.tags || ['browser-glass-overlay'],
        source: 'browser-glass-overlay',
      });
    }).then(result => {
      sendResponse(result);
    });
    return true;
  }

  // Recall from memory
  if (message.action === 'recall') {
    getConfig().then(config => {
      return recallFromHivemind(config, message.query);
    }).then(result => {
      sendResponse(result);
    });
    return true;
  }

  // Toggle overlay
  if (message.action === 'toggleOverlay') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'toggleOverlay' });
      sendResponse({ success: true });
    });
    return true;
  }
});

// ── Extension Icon Click ─────────────────────────────────────

chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, { action: 'toggleOverlay' });
});

// ── Context Menu (Keep existing) ─────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'hivemind-save-selection',
    title: 'Save to HIVEMIND',
    contexts: ['selection'],
  });

  chrome.contextMenus.create({
    id: 'hivemind-save-page',
    title: 'Save this page to HIVEMIND',
    contexts: ['page'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const config = await getConfig();
  if (!config.apiKey) {
    chrome.action.openPopup();
    return;
  }

  if (info.menuItemId === 'hivemind-save-selection') {
    const selectedText = info.selectionText;
    if (selectedText && selectedText.length > 10) {
      await saveToHivemind(config, {
        content: selectedText,
        title: `Web Selection: ${selectedText.slice(0, 50)}`,
        tags: ['browser-extension', 'selection', `url:${tab.url}`],
        source: 'context-menu',
      });
    }
  }

  if (info.menuItemId === 'hivemind-save-page') {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['extractors.js']
    }).then(() => {
      return chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => smartExtract()
      });
    }).then(results => {
      const pageContent = results[0]?.result;
      if (pageContent) {
        return saveToHivemind(config, {
          content: pageContent.content,
          title: pageContent.title || tab.title,
          tags: ['browser-extension', ...(pageContent.tags || []), `url:${tab.url}`],
          source: pageContent.platform || 'context-menu',
        });
      }
    });
  }
});
```

---

## Backend API Endpoint (NEW)

### POST `/api/chat-with-context`

```javascript
/**
 * New endpoint for glass overlay queries
 * Combines: user query + page context + HIVEMIND memory recall
 */
router.post('/api/chat-with-context', requireApiKey, async (req, res) => {
  const { message, context, history } = req.body;
  const userId = req.principal.userId;

  try {
    // 1. Extract query keywords from message
    const keywords = extractKeywords(message);
    
    // 2. Recall from HIVEMIND based on query + page context
    const memoryQuery = `
      User query: ${message}
      Current page: ${context?.title || ''}
      Page URL: ${context?.url || ''}
      Page content summary: ${(context?.visibleText || '').slice(0, 500)}
    `;
    
    const recalled = await recallMemories(userId, memoryQuery, { max: 5 });
    
    // 3. Build AI prompt with full context
    const systemPrompt = `You are HIVEMIND, a browser assistant with perfect memory.

**User's question:** ${message}

**Current page context:**
- Title: ${context?.title || 'Unknown'}
- URL: ${context?.url || 'Unknown'}
- Platform: ${context?.platform || 'generic'}
- Interactive elements: ${context?.interactiveElements?.length || 0}
- Visible text: ${(context?.visibleText || '').slice(0, 1000)}

**Recalled memories (${recalled.length}):**
${recalled.map((m, i) => `${i + 1}. ${m.title}\n   ${m.content.slice(0, 200)}\n   Score: ${m.score}`).join('\n\n')}

**Instructions:**
- Answer the user's question using the page context AND recalled memories
- If the question requires a browser action (click, fill, navigate), respond with:
  ACTION: <action_type> <target_element>
  Example: "ACTION: click @e15" or "ACTION: fill @e3 'search term'"
- Be concise and helpful
- Cite sources when using memories`;

    // 4. Call LLM (Groq or OpenAI)
    const llmResponse = await callGroq({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.slice(-4),
        { role: 'user', content: message },
      ],
      max_tokens: 500,
    });

    const answer = llmResponse.choices[0].message.content;

    // 5. Parse actions from response
    const actions = parseActions(answer, context);

    // 6. Return combined response
    res.json({
      answer: answer.replace(/ACTION:.*$/gm, '').trim(),
      sources: recalled.map(m => ({
        title: m.title,
        content: m.content.slice(0, 200),
        score: m.score,
      })),
      actions: actions,
      usage: {
        prompt_tokens: llmResponse.usage.prompt_tokens,
        completion_tokens: llmResponse.usage.completion_tokens,
      },
    });

  } catch (err) {
    console.error('[chat-with-context]', err);
    res.status(500).json({ error: err.message });
  }
});

// Parse ACTION commands from LLM response
function parseActions(text, context) {
  const actions = [];
  const actionRegex = /ACTION:\s*(\w+)\s+(@e\d+|\S+)(?:\s+(.+))?/gim;
  let match;

  while ((match = actionRegex.exec(text)) !== null) {
    const [, actionType, target, value] = match;
    
    actions.push({
      type: actionType.toLowerCase(), // click, fill, navigate
      tool: mapActionToKimiTool(actionType),
      args: buildKimiArgs(actionType, target, value),
      target: target,
    });
  }

  return actions;
}

function mapActionToKimiTool(actionType) {
  const map = {
    click: 'click',
    fill: 'fill',
    type: 'key_type',
    navigate: 'navigate',
    screenshot: 'screenshot',
  };
  return map[actionType.toLowerCase()] || 'click';
}

function buildKimiArgs(actionType, target, value) {
  const type = actionType.toLowerCase();
  
  if (type === 'click') {
    return { selector: target };
  }
  
  if (type === 'fill') {
    return { selector: target, value: value || '' };
  }
  
  if (type === 'navigate') {
    return { url: target };
  }
  
  if (type === 'screenshot') {
    return { selector: target || undefined };
  }
  
  return {};
}
```

---

## Implementation Roadmap

### Phase 1: Foundation (Week 1)
- [x] Architecture design (this document)
- [ ] Create `glass-overlay-inject.js` (main content script)
- [ ] Create `glass-overlay.css` (transparent glass styling)
- [ ] Update `manifest.json` (permissions + content script injection)
- [ ] Test: overlay appears/disappears on Cmd+Shift+H

### Phase 2: Context Capture (Week 2)
- [ ] Implement `capturePageContext()` (DOM + visible text)
- [ ] Integrate Kimi's `snapshot()` for accessibility tree
- [ ] Implement `extractInteractiveElements()` (@e refs)
- [ ] Test: context captured and displayed in status bar

### Phase 3: Chat with Context (Week 3)
- [ ] Implement backend `/api/chat-with-context` endpoint
- [ ] Combine user query + page context + HIVEMIND recall
- [ ] Test: "What's on this page?" returns accurate summary

### Phase 4: Action Execution (Week 4)
- [ ] Implement `parseActions()` (detect ACTION: commands)
- [ ] Implement `executeKimiTool()` (route to Kimi extension)
- [ ] Test: "Click the first button" executes click via Kimi

### Phase 5: Memory Persistence (Week 5)
- [ ] Implement `saveInteractionToMemory()` (auto-save Q&A)
- [ ] Tag interactions with URL, platform, action type
- [ ] Test: interactions saved and recallable in future sessions

### Phase 6: Polish & UX (Week 6)
- [ ] Add ghost cursor for action feedback
- [ ] Add toast notifications for actions
- [ ] Add screenshot preview mode
- [ ] Add voice input (optional — use TARA's VAD)
- [ ] Test: full user flow from activation to action to memory

---

## Success Metrics

1. **Context Awareness**: Overlay captures page DOM in <2 seconds
2. **Answer Quality**: 80%+ of answers cite relevant memories or page context
3. **Action Success Rate**: 90%+ of ACTION commands execute correctly
4. **Memory Persistence**: 100% of interactions saved to HIVEMIND
5. **Performance**: Overlay adds <50ms to page load time
6. **UX**: Users prefer overlay over popup (measured by usage frequency)

---

## Security & Privacy

1. **API Key Storage**: Chrome storage (encrypted by Chrome)
2. **Data Transmission**: HTTPS only (core.hivemind.davinciai.eu:8050)
3. **Page Context**: Never sent to third parties (only HIVEMIND backend)
4. **Kimi Integration**: Local extension-to-extension messaging (no external server)
5. **Memory Tagging**: All data tagged with `source: browser-glass-overlay` for transparency

---

## Future Enhancements

1. **Voice Mode**: Speak queries instead of typing (use TARA's VAD)
2. **Multi-Tab Context**: Query across multiple open tabs
3. **Screenshot Annotations**: Draw/highlight on page before asking
4. **Automation Macros**: Record sequences of actions as reusable macros
5. **Team Memory**: Share browser interactions with team members
6. **Mobile Extension**: Port to Safari/Firefox mobile browsers

---

## Conclusion

The **HIVEMIND Glass Overlay** transforms the current Chrome extension into a **transparent, context-aware browser assistant** that:

- **Sees** everything on the page (DOM, accessibility tree, visible text)
- **Remembers** everything (perfect memory via HIVEMIND API)
- **Acts** on commands (browser automation via Kimi WebBridge)
- **Persists** all interactions (auto-saves Q&A to memory)

This is not just a chat interface — it's a **second brain that lives in your browser**, always watching, always learning, always ready to help.

**Next Steps:**
1. Review this architecture with the team
2. Confirm backend endpoint design (`/api/chat-with-context`)
3. Start Phase 1 implementation
4. Ship alpha version for internal testing

---

**Document Version:** 1.0  
**Last Updated:** 2026-05-20  
**Author:** Claude Sonnet 4 (APEX Mode)  
**Repository:** `/Users/amar/HIVE-MIND/docs/TRANSPARENT_OVERLAY_ARCHITECTURE.md`
