# HIVEMIND Chat Extension - Implementation Plan

**Goal**: Transform HIVEMIND Chrome extension into a chat interface that:
- Shows as transparent overlay (like TARA)
- Captures DOM context (like Kimi)
- Routes through existing Talk to HIVE backend
- Executes actions via MCP tools
- Auto-saves to memory

**Timeline**: 2-3 weeks, 6 phases

---

## Phase 1: Foundation & Learning (Days 1-2)

### 1.1 Study Existing Systems

**Study Kimi WebBridge** (`/Users/amar/HIVE-MIND/kimi-webbridge-extension/`):
```bash
# Read these files in order:
1. manifest.json          # Permissions, background service worker
2. background.js          # Tool registry, CDP integration, WebSocket client
3. content.js (if exists) # Content script injection patterns
```

**Key Learnings Needed**:
- ✅ How Kimi attaches CDP debugger to tabs
- ✅ How snapshot() generates accessibility tree
- ✅ How tool execution flows: content → background → CDP
- ✅ How @e references work (element IDs)

**Study TARA Widget** (`/Users/amar/HIVE-MIND/extensions/chrome/dom_widget.html`):
```bash
# Already done - we have the pattern
```

**Key Learnings**:
- ✅ Glass morphism CSS (backdrop-filter)
- ✅ Overlay positioning and z-index management
- ✅ WebSocket communication pattern

**Study Current HIVEMIND Extension** (`/Users/amar/HIVE-MIND/extensions/chrome/`):
```bash
1. manifest.json          # Current permissions
2. background.js          # API integration patterns
3. extractors.js          # Platform detection
4. content-ai-inject.js   # Auto-capture patterns
```

**Deliverable**: Architecture diagram showing how all pieces connect

---

## Phase 2: Minimal Chat Overlay (Days 3-4)

### 2.1 Create Basic Chat UI

**File**: `/Users/amar/HIVE-MIND/extensions/chrome/chat-overlay.js` (NEW)

```javascript
/**
 * Minimal chat overlay - Phase 2
 * - Shows on Cmd+Shift+H
 * - Basic input + message display
 * - Routes to background.js
 */

(function() {
  'use strict';
  
  // State
  let overlayVisible = false;
  let messages = [];
  
  // Initialize
  function init() {
    createOverlayDOM();
    setupKeyboardShortcut();
    setupMessageListener();
  }
  
  // Create overlay HTML
  function createOverlayDOM() {
    const container = document.createElement('div');
    container.id = 'hivemind-chat-overlay';
    container.className = 'hivemind-hidden';
    container.innerHTML = `
      <div class="chat-panel">
        <div class="chat-header">
          <span>🧠 HIVEMIND Chat</span>
          <button id="close-chat">✕</button>
        </div>
        <div class="chat-messages" id="chat-messages">
          <div class="welcome-message">
            Press Cmd+Shift+H to start chatting
          </div>
        </div>
        <div class="chat-input-area">
          <input type="text" id="chat-input" placeholder="Ask anything..." />
          <button id="send-btn">Send</button>
        </div>
      </div>
    `;
    document.body.appendChild(container);
    
    // Event listeners
    document.getElementById('close-chat').onclick = hideOverlay;
    document.getElementById('send-btn').onclick = sendMessage;
    document.getElementById('chat-input').onkeydown = (e) => {
      if (e.key === 'Enter') sendMessage();
    };
  }
  
  // Keyboard shortcut
  function setupKeyboardShortcut() {
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'H') {
        e.preventDefault();
        toggleOverlay();
      }
    });
  }
  
  // Toggle visibility
  function toggleOverlay() {
    if (overlayVisible) {
      hideOverlay();
    } else {
      showOverlay();
    }
  }
  
  function showOverlay() {
    overlayVisible = true;
    document.getElementById('hivemind-chat-overlay').classList.remove('hivemind-hidden');
    document.getElementById('chat-input').focus();
  }
  
  function hideOverlay() {
    overlayVisible = false;
    document.getElementById('hivemind-chat-overlay').classList.add('hivemind-hidden');
  }
  
  // Send message
  function sendMessage() {
    const input = document.getElementById('chat-input');
    const message = input.value.trim();
    if (!message) return;
    
    // Add to UI
    addMessage('user', message);
    input.value = '';
    
    // Send to background
    chrome.runtime.sendMessage({
      action: 'chatMessage',
      message: message
    }, (response) => {
      if (response?.reply) {
        addMessage('assistant', response.reply);
      }
    });
  }
  
  // Add message to UI
  function addMessage(role, content) {
    const messagesDiv = document.getElementById('chat-messages');
    const messageEl = document.createElement('div');
    messageEl.className = `message ${role}-message`;
    messageEl.textContent = content;
    messagesDiv.appendChild(messageEl);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    
    messages.push({ role, content });
  }
  
  // Listen for messages from background
  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'toggleChat') {
        toggleOverlay();
        sendResponse({ success: true });
      }
    });
  }
  
  // Initialize on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
```

**File**: `/Users/amar/HIVE-MIND/extensions/chrome/chat-overlay.css` (NEW)

```css
/* Minimal chat overlay styles - Phase 2 */

#hivemind-chat-overlay {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 100%;
  z-index: 2147483647;
  pointer-events: none;
  transition: opacity 0.2s;
}

#hivemind-chat-overlay:not(.hivemind-hidden) {
  pointer-events: auto;
}

.hivemind-hidden {
  opacity: 0;
  pointer-events: none !important;
}

.chat-panel {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 400px;
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(20px);
  border-left: 1px solid rgba(0, 0, 0, 0.1);
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.1);
  display: flex;
  flex-direction: column;
  font-family: system-ui, -apple-system, sans-serif;
}

.chat-header {
  padding: 16px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.1);
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}

#close-chat {
  background: none;
  border: none;
  font-size: 20px;
  cursor: pointer;
  color: #666;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.message {
  padding: 10px 14px;
  border-radius: 12px;
  max-width: 80%;
  word-wrap: break-word;
}

.user-message {
  align-self: flex-end;
  background: #007aff;
  color: white;
}

.assistant-message {
  align-self: flex-start;
  background: #f0f0f0;
  color: #000;
}

.chat-input-area {
  padding: 16px;
  border-top: 1px solid rgba(0, 0, 0, 0.1);
  display: flex;
  gap: 8px;
}

#chat-input {
  flex: 1;
  padding: 10px 14px;
  border: 1px solid rgba(0, 0, 0, 0.2);
  border-radius: 8px;
  font-size: 14px;
  outline: none;
}

#send-btn {
  padding: 10px 20px;
  background: #007aff;
  color: white;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 600;
}
```

**Update**: `/Users/amar/HIVE-MIND/extensions/chrome/manifest.json`

```json
{
  "manifest_version": 3,
  "name": "HIVEMIND Chat",
  "version": "2.0.0",
  "description": "AI chat with memory and browser context",
  "permissions": [
    "activeTab",
    "storage",
    "scripting",
    "tabs"
  ],
  "host_permissions": [
    "https://core.hivemind.davinciai.eu:8050/*",
    "<all_urls>"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_popup": "popup.html",
    "default_icon": "icons/icon48.png"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["chat-overlay.js"],
      "css": ["chat-overlay.css"],
      "run_at": "document_idle"
    }
  ],
  "commands": {
    "toggle-chat": {
      "suggested_key": {
        "default": "Ctrl+Shift+H",
        "mac": "Command+Shift+H"
      },
      "description": "Toggle HIVEMIND chat"
    }
  }
}
```

**Update**: `/Users/amar/HIVE-MIND/extensions/chrome/background.js`

```javascript
// Add chat handler to existing background.js

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Phase 2: Minimal chat handler
  if (message.action === 'chatMessage') {
    // For now, echo back with prefix
    // Later: route to backend
    sendResponse({
      reply: `Echo: ${message.message}`
    });
    return true;
  }
  
  // ... existing handlers ...
});
```

**Test Phase 2**:
```bash
cd /Users/amar/HIVE-MIND/extensions/chrome
# Load unpacked extension in Chrome
# Navigate to any page
# Press Cmd+Shift+H
# Type "hello" → should see "Echo: hello"
```

**Success Criteria**:
- ✅ Overlay appears/disappears with Cmd+Shift+H
- ✅ Input field accepts text
- ✅ Messages display in chat
- ✅ Background receives messages

---

## Phase 3: Backend Integration (Days 5-6)

### 3.1 Connect to Talk to HIVE Backend

**Goal**: Route messages through existing `/v1/proxy/chat` endpoint

**Update**: `/Users/amar/HIVE-MIND/extensions/chrome/background.js`

```javascript
// Replace Phase 2 echo handler with real backend call

async function getConfig() {
  const result = await chrome.storage.local.get(['apiKey', 'apiBase']);
  return {
    apiKey: result.apiKey || '',
    apiBase: result.apiBase || 'https://core.hivemind.davinciai.eu:8050',
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'chatMessage') {
    handleChatMessage(message, sendResponse);
    return true; // Keep channel open for async
  }
  
  // ... existing handlers ...
});

async function handleChatMessage(message, sendResponse) {
  try {
    const config = await getConfig();
    
    if (!config.apiKey) {
      sendResponse({
        error: 'API key not configured. Click extension icon to set up.'
      });
      return;
    }
    
    // Call existing Talk to HIVE endpoint
    const response = await fetch(`${config.apiBase}/v1/proxy/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.apiKey,
      },
      body: JSON.stringify({
        message: message.message,
        model: 'llama-3.3-70b-versatile', // Default model
        history: message.history || [],
      }),
    });
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    sendResponse({
      reply: data.response,
      sources: data.sources || [],
      usage: data.usage || {},
    });
    
  } catch (err) {
    console.error('[HIVEMIND Chat] Error:', err);
    sendResponse({
      error: err.message
    });
  }
}
```

**Update**: `/Users/amar/HIVE-MIND/extensions/chrome/chat-overlay.js`

```javascript
// Update sendMessage() to include history and handle sources

let chatHistory = []; // Track conversation

function sendMessage() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;
  
  // Add to UI
  addMessage('user', message);
  input.value = '';
  
  // Show thinking indicator
  const thinkingId = addThinkingMessage();
  
  // Send to background with history
  chrome.runtime.sendMessage({
    action: 'chatMessage',
    message: message,
    history: chatHistory.slice(-6), // Last 6 messages for context
  }, (response) => {
    // Remove thinking indicator
    removeMessage(thinkingId);
    
    if (response?.error) {
      addMessage('system', `Error: ${response.error}`);
    } else if (response?.reply) {
      addMessage('assistant', response.reply, {
        sources: response.sources,
        usage: response.usage,
      });
    }
  });
  
  // Add to history
  chatHistory.push({ role: 'user', content: message });
}

function addMessage(role, content, options = {}) {
  const messagesDiv = document.getElementById('chat-messages');
  const messageEl = document.createElement('div');
  messageEl.className = `message ${role}-message`;
  
  // Main content
  const contentEl = document.createElement('div');
  contentEl.textContent = content;
  messageEl.appendChild(contentEl);
  
  // Sources (if any)
  if (options.sources && options.sources.length > 0) {
    const sourcesEl = document.createElement('div');
    sourcesEl.className = 'message-sources';
    sourcesEl.innerHTML = `<div class="sources-label">📚 ${options.sources.length} sources</div>`;
    options.sources.forEach(s => {
      const sourceItem = document.createElement('div');
      sourceItem.className = 'source-item';
      sourceItem.textContent = s.title;
      sourceItem.title = s.content.slice(0, 200);
      sourcesEl.appendChild(sourceItem);
    });
    messageEl.appendChild(sourcesEl);
  }
  
  messagesDiv.appendChild(messageEl);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
  
  if (role !== 'system') {
    chatHistory.push({ role, content });
  }
  
  return messageEl.id;
}

function addThinkingMessage() {
  const messagesDiv = document.getElementById('chat-messages');
  const messageEl = document.createElement('div');
  messageEl.id = `thinking-${Date.now()}`;
  messageEl.className = 'message assistant-message thinking';
  messageEl.textContent = '...';
  messagesDiv.appendChild(messageEl);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
  return messageEl.id;
}

function removeMessage(id) {
  document.getElementById(id)?.remove();
}
```

**Update**: `/Users/amar/HIVE-MIND/extensions/chrome/chat-overlay.css`

```css
/* Add source styling */

.message-sources {
  margin-top: 8px;
  padding: 8px;
  background: rgba(0, 0, 0, 0.05);
  border-radius: 6px;
  font-size: 12px;
}

.sources-label {
  font-weight: 600;
  margin-bottom: 4px;
  color: #666;
}

.source-item {
  padding: 4px 8px;
  background: rgba(255, 255, 255, 0.8);
  border-radius: 4px;
  margin-bottom: 2px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thinking {
  opacity: 0.5;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 0.8; }
}
```

**Test Phase 3**:
```bash
# Load extension
# Press Cmd+Shift+H
# Type: "What do I know about TypeScript?"
# Should get: Real answer from HIVEMIND with sources
```

**Success Criteria**:
- ✅ Messages route to backend
- ✅ Responses appear with recalled memories
- ✅ Sources displayed
- ✅ History maintained across messages

---

## Phase 4: DOM Context Capture (Days 7-9)

### 4.1 Learn from Kimi's Snapshot

**Study**: `/Users/amar/HIVE-MIND/kimi-webbridge-extension/background.js`

Find the `SnapshotTool` class:
```javascript
// Look for how Kimi uses CDP to get accessibility tree
// Key method: chrome.debugger.sendCommand(tabId, 'Accessibility.getFullAXTree')
```

**Key Learnings**:
1. Kimi attaches CDP debugger: `chrome.debugger.attach(tabId, "1.3")`
2. Gets accessibility tree: `Accessibility.getFullAXTree`
3. Parses tree to extract elements with roles (button, link, textbox)
4. Assigns @e references for easy targeting

### 4.2 Implement Context Capture

**Option A: Use Kimi Extension (if installed)**

```javascript
// In background.js - detect if Kimi is available
async function checkKimiExtension() {
  try {
    // Kimi extension ID (get from Chrome store or manifest)
    const KIMI_ID = 'your-kimi-extension-id-here';
    const response = await chrome.runtime.sendMessage(KIMI_ID, {
      type: 'GET_CAPABILITIES'
    });
    return response?.available === true;
  } catch {
    return false;
  }
}

async function getPageSnapshot(tabId) {
  // Try Kimi first
  const kimiAvailable = await checkKimiExtension();
  
  if (kimiAvailable) {
    return await getSnapshotViaKimi(tabId);
  } else {
    return await getSnapshotNative(tabId);
  }
}

async function getSnapshotViaKimi(tabId) {
  const KIMI_ID = 'your-kimi-extension-id-here';
  const response = await chrome.runtime.sendMessage(KIMI_ID, {
    type: 'EXECUTE_TOOL',
    tool: 'snapshot',
    tabId: tabId
  });
  return response.data;
}
```

**Option B: Native Implementation (no Kimi dependency)**

```javascript
// In background.js
async function getSnapshotNative(tabId) {
  try {
    // Attach debugger
    await chrome.debugger.attach({ tabId }, "1.3");
    
    // Enable Accessibility domain
    await chrome.debugger.sendCommand({ tabId }, "Accessibility.enable");
    
    // Get full accessibility tree
    const result = await chrome.debugger.sendCommand(
      { tabId },
      "Accessibility.getFullAXTree"
    );
    
    // Detach debugger
    await chrome.debugger.detach({ tabId });
    
    // Parse tree
    const tree = parseAccessibilityTree(result.nodes);
    
    return {
      tree: tree,
      interactiveElements: extractInteractiveElements(tree),
    };
    
  } catch (err) {
    console.error('[Snapshot] Failed:', err);
    return null;
  }
}

function parseAccessibilityTree(nodes) {
  // Convert Chrome's AX tree format to simplified structure
  const nodeMap = {};
  nodes.forEach(node => {
    nodeMap[node.nodeId] = {
      id: node.nodeId,
      role: node.role?.value,
      name: node.name?.value || '',
      value: node.value?.value || '',
      children: node.childIds || [],
    };
  });
  
  // Build tree structure
  return Object.values(nodeMap);
}

function extractInteractiveElements(nodes) {
  const interactive = [];
  const roles = ['button', 'link', 'textbox', 'checkbox', 'combobox', 'menuitem'];
  
  nodes.forEach((node, index) => {
    if (roles.includes(node.role)) {
      interactive.push({
        ref: `@e${index}`,
        role: node.role,
        name: node.name,
        value: node.value,
      });
    }
  });
  
  return interactive;
}
```

**Update manifest.json** for CDP access:

```json
{
  "permissions": [
    "activeTab",
    "storage",
    "scripting",
    "tabs",
    "debugger"  // NEW - for CDP access
  ]
}
```

### 4.3 Capture Context on Chat Open

**Update**: `/Users/amar/HIVE-MIND/extensions/chrome/chat-overlay.js`

```javascript
// Capture context when overlay opens
async function showOverlay() {
  overlayVisible = true;
  document.getElementById('hivemind-chat-overlay').classList.remove('hivemind-hidden');
  document.getElementById('chat-input').focus();
  
  // NEW: Capture page context
  await capturePageContext();
}

let currentPageContext = null;

async function capturePageContext() {
  // Update status
  showStatus('Capturing page context...');
  
  try {
    // Request context from background
    const context = await chrome.runtime.sendMessage({
      action: 'captureContext'
    });
    
    if (context) {
      currentPageContext = context;
      showStatus(`✓ Context ready · ${context.interactiveElements?.length || 0} interactive elements`);
    }
  } catch (err) {
    console.error('[Context Capture] Failed:', err);
    showStatus('⚠ Context capture failed');
  }
}

function showStatus(message) {
  // Add status bar to overlay (if not exists)
  let statusBar = document.querySelector('.context-status');
  if (!statusBar) {
    statusBar = document.createElement('div');
    statusBar.className = 'context-status';
    document.querySelector('.chat-panel').insertBefore(
      statusBar,
      document.querySelector('.chat-messages')
    );
  }
  statusBar.textContent = message;
}
```

**Update**: `/Users/amar/HIVE-MIND/extensions/chrome/background.js`

```javascript
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'captureContext') {
    handleCaptureContext(sender.tab.id, sendResponse);
    return true;
  }
  
  // ... existing handlers ...
});

async function handleCaptureContext(tabId, sendResponse) {
  try {
    // Get DOM snapshot
    const snapshot = await getSnapshotNative(tabId);
    
    // Get visible text via content script
    const [visibleText] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // Extract visible text
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: (node) => {
              const parent = node.parentElement;
              if (!parent) return NodeFilter.FILTER_REJECT;
              const style = window.getComputedStyle(parent);
              if (style.display === 'none' || style.visibility === 'hidden') {
                return NodeFilter.FILTER_REJECT;
              }
              return node.textContent.trim().length > 0 
                ? NodeFilter.FILTER_ACCEPT 
                : NodeFilter.FILTER_REJECT;
            }
          }
        );
        
        const texts = [];
        let node;
        while (node = walker.nextNode()) {
          texts.push(node.textContent.trim());
        }
        return texts.join(' ').slice(0, 4000);
      }
    });
    
    // Get page info
    const [pageInfo] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        url: window.location.href,
        title: document.title,
        hostname: window.location.hostname,
      })
    });
    
    // Combine context
    const context = {
      ...pageInfo.result,
      timestamp: new Date().toISOString(),
      visibleText: visibleText.result,
      accessibilityTree: snapshot?.tree,
      interactiveElements: snapshot?.interactiveElements || [],
    };
    
    sendResponse(context);
    
  } catch (err) {
    console.error('[Capture Context]', err);
    sendResponse({ error: err.message });
  }
}
```

**Test Phase 4**:
```bash
# Load extension
# Navigate to https://github.com/microsoft/vscode
# Press Cmd+Shift+H
# Should see: "✓ Context ready · 47 interactive elements"
# Type: "What's on this page?"
# Should get: Answer using page content
```

**Success Criteria**:
- ✅ Context captured on overlay open (<2s)
- ✅ Accessibility tree extracted
- ✅ Interactive elements identified
- ✅ Visible text captured

---

## Phase 5: Context-Aware Chat (Days 10-12)

### 5.1 Create New Backend Endpoint

**File**: `/Users/amar/HIVE-MIND/core/src/routes/chat.js` (or add to existing)

```javascript
/**
 * POST /api/chat-with-context
 * 
 * Enhanced chat endpoint that:
 * - Accepts page context
 * - Recalls memories based on context + query
 * - Returns answer + sources + actions
 */

router.post('/api/chat-with-context', requireApiKey, async (req, res) => {
  const { message, context, history } = req.body;
  const userId = req.principal.userId;
  
  try {
    // 1. Build enhanced query with context
    const enhancedQuery = `
User query: ${message}

Current page context:
- URL: ${context?.url || 'unknown'}
- Title: ${context?.title || 'unknown'}
- Interactive elements: ${context?.interactiveElements?.length || 0}
- Visible text summary: ${(context?.visibleText || '').slice(0, 500)}
    `.trim();
    
    // 2. Recall memories
    const recalled = await recallMemories(userId, enhancedQuery, { max: 5 });
    
    // 3. Build AI prompt
    const systemPrompt = `You are HIVEMIND, an AI assistant with access to the user's memory and current browser context.

**Current page:**
- URL: ${context?.url}
- Title: ${context?.title}
- Visible content: ${(context?.visibleText || '').slice(0, 1000)}

**Interactive elements on page:**
${(context?.interactiveElements || []).slice(0, 20).map((el, i) => 
  `${el.ref}: ${el.role} - "${el.name}"`
).join('\n')}

**Recalled memories (${recalled.length}):**
${recalled.map((m, i) => `${i+1}. ${m.title}\n   ${m.content.slice(0, 150)}\n   (score: ${m.score})`).join('\n\n')}

**Instructions:**
- Answer the user's question using BOTH page context and recalled memories
- If the question is about the current page, reference specific elements
- If an action is needed, respond with: ACTION: <type> <target>
  Examples:
    - "ACTION: click @e5" (click element 5)
    - "ACTION: fill @e12 'search term'" (fill textbox 12)
    - "ACTION: navigate https://example.com" (navigate to URL)
- Be concise and helpful`;

    // 4. Call LLM
    const llmResponse = await callGroq({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        ...(history || []).slice(-4),
        { role: 'user', content: message },
      ],
      max_tokens: 600,
      temperature: 0.7,
    });
    
    const rawAnswer = llmResponse.choices[0].message.content;
    
    // 5. Parse actions
    const actions = parseActionsFromResponse(rawAnswer, context);
    
    // 6. Clean answer (remove ACTION lines)
    const cleanAnswer = rawAnswer.replace(/ACTION:.*$/gm, '').trim();
    
    // 7. Return response
    res.json({
      response: cleanAnswer,
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

function parseActionsFromResponse(text, context) {
  const actions = [];
  const regex = /ACTION:\s*(\w+)\s+(@e\d+|https?:\/\/\S+|\S+)(?:\s+(.+))?/gim;
  let match;
  
  while ((match = regex.exec(text)) !== null) {
    const [, actionType, target, value] = match;
    actions.push({
      type: actionType.toLowerCase(),
      target: target,
      value: value,
    });
  }
  
  return actions;
}
```

### 5.2 Update Extension to Use New Endpoint

**Update**: `/Users/amar/HIVE-MIND/extensions/chrome/background.js`

```javascript
async function handleChatMessage(message, sendResponse) {
  try {
    const config = await getConfig();
    
    if (!config.apiKey) {
      sendResponse({ error: 'API key not configured' });
      return;
    }
    
    // NEW: Use /api/chat-with-context instead of /v1/proxy/chat
    const response = await fetch(`${config.apiBase}/api/chat-with-context`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.apiKey,
      },
      body: JSON.stringify({
        message: message.message,
        context: message.context, // NEW: Include page context
        history: message.history || [],
      }),
    });
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    sendResponse({
      reply: data.response,
      sources: data.sources || [],
      actions: data.actions || [], // NEW: Actions to execute
      usage: data.usage || {},
    });
    
  } catch (err) {
    console.error('[HIVEMIND Chat]', err);
    sendResponse({ error: err.message });
  }
}
```

**Update**: `/Users/amar/HIVE-MIND/extensions/chrome/chat-overlay.js`

```javascript
function sendMessage() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;
  
  addMessage('user', message);
  input.value = '';
  
  const thinkingId = addThinkingMessage();
  
  // NEW: Include page context
  chrome.runtime.sendMessage({
    action: 'chatMessage',
    message: message,
    context: currentPageContext, // NEW
    history: chatHistory.slice(-6),
  }, (response) => {
    removeMessage(thinkingId);
    
    if (response?.error) {
      addMessage('system', `Error: ${response.error}`);
    } else if (response?.reply) {
      addMessage('assistant', response.reply, {
        sources: response.sources,
        actions: response.actions, // NEW
      });
      
      // NEW: Execute actions if any
      if (response.actions && response.actions.length > 0) {
        executeActions(response.actions);
      }
    }
  });
  
  chatHistory.push({ role: 'user', content: message });
}
```

**Test Phase 5**:
```bash
# Navigate to https://github.com
# Press Cmd+Shift+H
# Type: "What's on this page?"
# Should get: Detailed answer using page content
# Type: "What repositories are showing?"
# Should get: List extracted from page
```

**Success Criteria**:
- ✅ Backend receives page context
- ✅ AI answers using page content
- ✅ Memories recalled with context
- ✅ Actions parsed from response

---

## Phase 6: Action Execution (Days 13-14)

### 6.1 Implement Action Executor

**Update**: `/Users/amar/HIVE-MIND/extensions/chrome/chat-overlay.js`

```javascript
async function executeActions(actions) {
  for (const action of actions) {
    try {
      await executeAction(action);
      showActionFeedback(action, 'success');
    } catch (err) {
      console.error('[Action Execution]', err);
      showActionFeedback(action, 'failed');
    }
  }
}

async function executeAction(action) {
  const { type, target, value } = action;
  
  if (type === 'click') {
    // Find element by @e reference or selector
    if (target.startsWith('@e')) {
      const index = parseInt(target.slice(2));
      const element = currentPageContext?.interactiveElements?.[index];
      if (element) {
        // Click via DOM
        await clickElement(element);
      }
    } else {
      // Click via selector
      await clickSelector(target);
    }
  }
  
  if (type === 'fill') {
    if (target.startsWith('@e')) {
      const index = parseInt(target.slice(2));
      await fillElement(index, value);
    } else {
      await fillSelector(target, value);
    }
  }
  
  if (type === 'navigate') {
    window.location.href = target;
  }
}

async function clickElement(element) {
  // Use element's name/role to find it in DOM
  const selector = buildSelectorFromElement(element);
  await clickSelector(selector);
}

async function clickSelector(selector) {
  const el = document.querySelector(selector);
  if (el) {
    el.click();
    return true;
  }
  throw new Error(`Element not found: ${selector}`);
}

async function fillElement(index, value) {
  const element = currentPageContext?.interactiveElements?.[index];
  if (!element) throw new Error('Element not found');
  
  const selector = buildSelectorFromElement(element);
  const el = document.querySelector(selector);
  if (el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
  }
  throw new Error('Cannot fill element');
}

function buildSelectorFromElement(element) {
  // Try to build CSS selector from element info
  // This is a heuristic - may need refinement
  
  if (element.role === 'button' && element.name) {
    return `button:contains("${element.name}")`;
  }
  
  if (element.role === 'link' && element.name) {
    return `a:contains("${element.name}")`;
  }
  
  if (element.role === 'textbox') {
    return `input[type="text"], input[type="search"], textarea`;
  }
  
  // Fallback: try by aria-label or title
  if (element.name) {
    return `[aria-label="${element.name}"], [title="${element.name}"]`;
  }
  
  return null;
}

function showActionFeedback(action, status) {
  // Show toast notification
  const toast = document.createElement('div');
  toast.className = `action-toast ${status}`;
  toast.textContent = status === 'success' 
    ? `✓ ${action.type} executed` 
    : `✗ ${action.type} failed`;
  document.body.appendChild(toast);
  
  setTimeout(() => toast.remove(), 2000);
}
```

**Add CSS for action feedback**:

```css
.action-toast {
  position: fixed;
  bottom: 24px;
  right: 420px; /* Next to chat panel */
  padding: 12px 20px;
  background: rgba(0, 0, 0, 0.9);
  color: white;
  border-radius: 8px;
  font-size: 14px;
  z-index: 2147483646;
  animation: slideIn 0.3s ease;
}

.action-toast.success {
  background: rgba(34, 197, 94, 0.9);
}

.action-toast.failed {
  background: rgba(239, 68, 68, 0.9);
}

@keyframes slideIn {
  from {
    transform: translateX(100px);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}
```

**Test Phase 6**:
```bash
# Navigate to https://github.com/search
# Press Cmd+Shift+H
# Type: "Search for 'typescript'"
# AI should: Extract search input, return ACTION: fill @e3 'typescript'
# Extension should: Fill the search box automatically
# Type: "Click search"
# AI should: Return ACTION: click @e4
# Extension should: Click the search button
```

**Success Criteria**:
- ✅ Click actions execute
- ✅ Fill actions execute
- ✅ Navigate actions work
- ✅ Visual feedback shown
- ✅ Errors handled gracefully

---

## Phase 7: Memory Auto-Save (Day 15)

### 7.1 Auto-Save Every Interaction

**Update**: `/Users/amar/HIVE-MIND/extensions/chrome/chat-overlay.js`

```javascript
async function sendMessage() {
  // ... existing code ...
  
  chrome.runtime.sendMessage({
    action: 'chatMessage',
    message: message,
    context: currentPageContext,
    history: chatHistory.slice(-6),
  }, async (response) => {
    removeMessage(thinkingId);
    
    if (response?.reply) {
      addMessage('assistant', response.reply, {
        sources: response.sources,
        actions: response.actions,
      });
      
      if (response.actions && response.actions.length > 0) {
        await executeActions(response.actions);
      }
      
      // NEW: Auto-save interaction to memory
      await saveInteractionToMemory(message, response);
    }
  });
}

async function saveInteractionToMemory(userMessage, aiResponse) {
  try {
    const context = currentPageContext;
    
    const content = `Q: ${userMessage}\nA: ${aiResponse.reply}`;
    const title = `Chat on ${context?.title || window.location.hostname}`;
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
    console.error('[Memory Save]', err);
  }
}

function detectPlatform(hostname) {
  if (hostname.includes('github.com')) return 'github';
  if (hostname.includes('stackoverflow.com')) return 'stackoverflow';
  if (hostname.includes('twitter.com')) return 'twitter';
  if (hostname.includes('linkedin.com')) return 'linkedin';
  return 'web';
}
```

**Update**: `/Users/amar/HIVE-MIND/extensions/chrome/background.js`

```javascript
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'saveToMemory') {
    handleSaveToMemory(message, sendResponse);
    return true;
  }
  
  // ... existing handlers ...
});

async function handleSaveToMemory(message, sendResponse) {
  try {
    const config = await getConfig();
    
    const response = await fetch(`${config.apiBase}/api/memories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.apiKey,
      },
      body: JSON.stringify({
        content: message.content,
        title: message.title,
        tags: message.tags,
        memory_type: 'fact',
        source_metadata: {
          source_type: 'browser-chat',
          source_platform: message.tags.find(t => t.startsWith('platform:'))?.split(':')[1] || 'web',
          source_url: message.context?.url,
          timestamp: message.context?.timestamp,
        },
      }),
    });
    
    if (response.ok) {
      const data = await response.json();
      sendResponse({ success: true, memoryId: data.memory?.id });
    } else {
      sendResponse({ success: false, error: 'Save failed' });
    }
    
  } catch (err) {
    console.error('[Save to Memory]', err);
    sendResponse({ success: false, error: err.message });
  }
}
```

**Test Phase 7**:
```bash
# Have a conversation with the chat
# Query backend: "Show me recent memories tagged 'browser-chat'"
# Should see: All chat interactions saved with context
# Type in chat: "What did we talk about earlier?"
# Should get: Recalled from saved memories
```

**Success Criteria**:
- ✅ Every interaction saved automatically
- ✅ Tagged with URL, platform, action type
- ✅ Retrievable in future sessions
- ✅ No duplicate saves

---

## Phase 8: Polish & Testing (Days 16-18)

### 8.1 UI Improvements

- Add model selector (dropdown for different Groq models)
- Add settings panel (API key, model, auto-save toggle)
- Add clear chat button
- Add export chat as markdown
- Improve mobile responsiveness (if needed)

### 8.2 Error Handling

- Graceful degradation if backend is down
- Retry logic for failed API calls
- Clear error messages for users
- Offline mode (show cached memories)

### 8.3 Performance Optimization

- Debounce context capture (don't capture on every page navigation)
- Cache context for 30 seconds (avoid re-capturing)
- Lazy load chat history from storage
- Optimize CSS animations

### 8.4 Security Audit

- Review permissions (minimize to essentials)
- Add CSP (Content Security Policy)
- Sanitize user input before display
- Encrypt API key in storage (if possible)

### 8.5 Testing Checklist

**Manual Testing**:
- [ ] Chat opens/closes with keyboard shortcut
- [ ] Messages send and receive correctly
- [ ] Context captured on different sites (GitHub, Stack Overflow, news sites)
- [ ] Actions execute (click, fill, navigate)
- [ ] Memory saves automatically
- [ ] Recalled memories appear in chat
- [ ] Sources displayed correctly
- [ ] Error handling works (no API key, network error, invalid response)

**Browser Compatibility**:
- [ ] Chrome (Manifest v3)
- [ ] Edge (Manifest v3)
- [ ] Brave (Manifest v3)

**Performance**:
- [ ] Extension adds <50ms to page load
- [ ] Context capture completes in <2s
- [ ] Chat response time <3s (network dependent)
- [ ] No memory leaks (test with 50+ messages)

---

## Deployment

### 9.1 Package Extension

```bash
cd /Users/amar/HIVE-MIND/extensions/chrome
zip -r hivemind-chat-v2.0.0.zip . -x "*.git*" -x "*node_modules*" -x "*.DS_Store"
```

### 9.2 Internal Testing

1. Load unpacked in Chrome
2. Share with 5-10 internal testers
3. Collect feedback via Google Form
4. Iterate based on feedback (1 week)

### 9.3 Chrome Web Store Submission

1. Create listing page (screenshots, description)
2. Submit for review
3. Monitor approval status
4. Publish when approved

### 9.4 Documentation

- Update README.md with installation instructions
- Create user guide (video walkthrough)
- Document API endpoints for backend team
- Create troubleshooting guide

---

## Success Metrics

**Week 1** (Phases 1-3):
- [ ] Chat overlay functional
- [ ] Backend integration working
- [ ] 10+ test conversations completed

**Week 2** (Phases 4-6):
- [ ] Context capture working
- [ ] Actions executing
- [ ] 50+ interactions with actions

**Week 3** (Phases 7-8):
- [ ] Memory auto-save working
- [ ] 5 internal testers onboarded
- [ ] <5 critical bugs reported

**Post-Launch** (Month 1):
- [ ] 100+ users
- [ ] 10,000+ chat messages
- [ ] 5,000+ actions executed
- [ ] <1% error rate

---

## Risk Mitigation

**Risk 1**: CDP debugger permission is scary for users
- **Mitigation**: Make it optional, fall back to simpler context capture

**Risk 2**: Kimi integration breaks if their API changes
- **Mitigation**: Build native fallback, don't hard-depend on Kimi

**Risk 3**: Backend gets overloaded with context data
- **Mitigation**: Limit context size (4000 chars), add rate limiting

**Risk 4**: Action execution breaks sites (clicks wrong element)
- **Mitigation**: Add confirmation dialog for actions, allow undo

**Risk 5**: Users don't understand how to use it
- **Mitigation**: Add onboarding tooltip, example prompts, video tutorial

---

## Next Steps After Launch

1. **Enterprise Dashboard** (Phase 2 from previous doc)
   - Admin panel for companies
   - Team memory sharing
   - Usage analytics

2. **Advanced Actions**
   - Macro recording (repeat multi-step workflows)
   - Conditional actions (if/then)
   - Scheduled actions (do X at Y time)

3. **Voice Mode**
   - Speak queries instead of typing
   - TTS for responses

4. **Mobile Extension**
   - Port to Safari iOS
   - Port to Firefox Android

---

## Appendix: File Structure

```
/Users/amar/HIVE-MIND/extensions/chrome/
├── manifest.json (v2.0.0)
├── background.js (updated with CDP, context capture, action routing)
├── chat-overlay.js (NEW - main chat UI)
├── chat-overlay.css (NEW - glass morphism styles)
├── popup.html (existing - for settings)
├── popup.js (existing - settings UI)
├── extractors.js (existing - platform detection)
├── content-ai-inject.js (existing - keep for auto-capture)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md (updated with v2.0 instructions)
```

**Backend Changes**:
```
/Users/amar/HIVE-MIND/core/src/routes/
├── chat.js (NEW endpoint: POST /api/chat-with-context)
└── memories.js (existing - no changes needed)
```

---

**Ready to start Phase 1?**

Let me know when you want to begin implementation. I recommend:
1. First, study Kimi's background.js (30 min)
2. Then start Phase 2 (build minimal overlay) (2-3 hours)
3. Test Phase 2 before moving to Phase 3

Each phase is designed to be independently testable so you can validate progress incrementally.
