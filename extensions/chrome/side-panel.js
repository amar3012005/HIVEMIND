// ══════════════════════════════════════════════════════════════
// HIVEMIND Side Panel — Persistent Chat with Memory
// ══════════════════════════════════════════════════════════════

// ── State Management ──────────────────────────────────────────
let chatHistory = [];
let currentPageContext = null;
let currentTabId = null;
let isCapturing = false;

// ── DOM Elements ──────────────────────────────────────────────
const messagesContainer = document.getElementById('messages');
const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const captureButton = document.getElementById('capture-button');
const saveSessionButton = document.getElementById('save-session-button');
const contextUrl = document.getElementById('context-url');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');

// Setup modal elements
const setupModal = document.getElementById('setup-modal');
const setupApiKey = document.getElementById('setup-api-key');
const setupApiBase = document.getElementById('setup-api-base');
const setupConnectButton = document.getElementById('setup-connect-button');
const setupStatus = document.getElementById('setup-status');

// ── Initialization ────────────────────────────────────────────
async function init() {
  // Check if API key is configured
  const hasConfig = await checkConfig();
  
  if (!hasConfig) {
    // Show setup modal
    setupModal.classList.remove('hidden');
    
    // Set up setup form handler
    setupConnectButton.addEventListener('click', handleSetup);
    setupApiKey.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSetup();
    });
    setupApiBase.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSetup();
    });
    
    // Disable chat until configured
    messageInput.disabled = true;
    messageInput.placeholder = 'Configure API key first...';
    sendButton.disabled = true;
    captureButton.disabled = true;
    saveSessionButton.disabled = true;
    
    console.log('[side-panel] Awaiting API key configuration');
    return; // Don't proceed with initialization
  }
  
  // Load chat history from storage
  await loadChatHistory();
  
  // Get current tab info
  await updateCurrentTab();
  
  // Set up event listeners
  sendButton.addEventListener('click', handleSend);
  messageInput.addEventListener('keydown', handleKeydown);
  captureButton.addEventListener('click', handleCapture);
  saveSessionButton.addEventListener('click', handleSaveSession);
  
  // Auto-resize textarea
  messageInput.addEventListener('input', autoResize);
  
  // Listen for tab changes
  chrome.tabs.onActivated.addListener(handleTabChange);
  chrome.tabs.onUpdated.addListener(handleTabUpdate);
  
  // Listen for messages from background
  chrome.runtime.onMessage.addListener(handleBackgroundMessage);
  
  // Listen for storage changes (API key configuration)
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.apiKey) {
      console.log('[side-panel] API key configured, reloading...');
      location.reload(); // Reload side panel to re-initialize
    }
  });
  
  // Check connection status
  updateConnectionStatus();
  
  console.log('[side-panel] Initialized');
}

// ── Config Check ──────────────────────────────────────────────
async function checkConfig() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getConfig' });
    return response?.apiKey && response.apiKey.length > 0;
  } catch (err) {
    console.error('[side-panel] Config check failed:', err);
    return false;
  }
}

// ── Setup Handler ─────────────────────────────────────────────
async function handleSetup() {
  const apiKey = setupApiKey.value.trim();
  const apiBase = setupApiBase.value.trim() || 'https://core.hivemind.davinciai.eu:8050';
  
  if (!apiKey) {
    setupStatus.innerHTML = '<div class="hivemind-setup-error">Please enter an API key</div>';
    return;
  }
  
  // Disable form during save
  setupConnectButton.disabled = true;
  setupConnectButton.textContent = 'Connecting...';
  setupStatus.innerHTML = '';
  
  try {
    // Save configuration
    await chrome.storage.local.set({ 
      apiKey, 
      apiBase,
      userId: '' 
    });
    
    // Show success message
    setupStatus.innerHTML = '<div class="hivemind-setup-success">✓ Connected! Initializing...</div>';
    
    // Wait a moment then reload
    setTimeout(() => {
      location.reload();
    }, 800);
    
  } catch (err) {
    console.error('[side-panel] Setup failed:', err);
    setupStatus.innerHTML = `<div class="hivemind-setup-error">Failed to save: ${err.message}</div>`;
    setupConnectButton.disabled = false;
    setupConnectButton.textContent = 'Connect to HIVEMIND';
  }
}

// ── Chat History Management ───────────────────────────────────
async function loadChatHistory() {
  try {
    const result = await chrome.storage.local.get(['chatHistory']);
    if (result.chatHistory && Array.isArray(result.chatHistory)) {
      chatHistory = result.chatHistory;
      
      // Clear welcome message
      messagesContainer.innerHTML = '';
      
      // Render all messages
      chatHistory.forEach(msg => {
        addMessage(msg.role, msg.content, msg.metadata);
      });
      
      scrollToBottom();
    }
  } catch (err) {
    console.error('[side-panel] Failed to load history:', err);
  }
}

async function saveChatHistory() {
  try {
    await chrome.storage.local.set({ chatHistory });
  } catch (err) {
    console.error('[side-panel] Failed to save history:', err);
  }
}

function clearWelcome() {
  const welcome = messagesContainer.querySelector('.hivemind-welcome');
  if (welcome) {
    welcome.remove();
  }
}

// ── Tab Management ────────────────────────────────────────────
async function updateCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      currentTabId = tab.id;
      updateContextBar(tab.url, tab.title);
    }
  } catch (err) {
    console.error('[side-panel] Failed to get current tab:', err);
  }
}

async function handleTabChange(activeInfo) {
  currentTabId = activeInfo.tabId;
  const tab = await chrome.tabs.get(currentTabId);
  updateContextBar(tab.url, tab.title);
  
  // Reset context when tab changes
  currentPageContext = null;
  captureButton.classList.remove('captured');
  captureButton.textContent = 'Capture Context';
}

async function handleTabUpdate(tabId, changeInfo, tab) {
  if (tabId === currentTabId && changeInfo.url) {
    updateContextBar(tab.url, tab.title);
    
    // Reset context when URL changes
    currentPageContext = null;
    captureButton.classList.remove('captured');
    captureButton.textContent = 'Capture Context';
  }
}

function updateContextBar(url, title) {
  if (url) {
    try {
      const urlObj = new URL(url);
      contextUrl.textContent = `${urlObj.hostname}${urlObj.pathname}`;
      contextUrl.title = title || url;
    } catch {
      contextUrl.textContent = url;
      contextUrl.title = title || url;
    }
  } else {
    contextUrl.textContent = 'No page selected';
    contextUrl.title = '';
  }
}

// ── Page Context Capture ──────────────────────────────────────
async function handleCapture() {
  if (isCapturing) return;
  
  isCapturing = true;
  captureButton.disabled = true;
  captureButton.textContent = 'Capturing...';
  
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'captureContext',
      tabId: currentTabId,
    });
    
    if (response?.context) {
      currentPageContext = response.context;
      captureButton.classList.add('captured');
      captureButton.textContent = '✓ Captured';
      
      addMessage('system', `Captured page context: ${response.context.elementCount} interactive elements`);
    } else {
      throw new Error(response?.error || 'Failed to capture context');
    }
  } catch (err) {
    console.error('[side-panel] Capture failed:', err);
    addMessage('system', `Capture failed: ${err.message}`, { isError: true });
    captureButton.textContent = 'Retry';
  } finally {
    isCapturing = false;
    captureButton.disabled = false;
  }
}

// ── Save Session ──────────────────────────────────────────────
async function handleSaveSession() {
  if (!currentTabId) {
    addMessage('system', 'No active tab', { isError: true });
    return;
  }
  
  saveSessionButton.disabled = true;
  saveSessionButton.textContent = '💾 Saving...';
  
  try {
    // Get current tab info
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      throw new Error('No active tab found');
    }
    
    // Try AI chat auto-capture first
    const response = await chrome.runtime.sendMessage({
      action: 'captureAISession',
      tabId: tab.id,
    });
    
    if (response.success) {
      saveSessionButton.textContent = '✓ Saved';
      if (response.fallback) {
        addMessage('system', `Session saved (fallback mode)`);
      } else {
        addMessage('system', `Session saved: ${response.platform} with ${response.messageCount} messages`);
      }
    } else {
      throw new Error(response.error || 'Failed to save session');
    }
  } catch (err) {
    console.error('[side-panel] Save session failed:', err);
    addMessage('system', `Save failed: ${err.message}`, { isError: true });
    saveSessionButton.textContent = '💾 Retry';
  } finally {
    setTimeout(() => {
      saveSessionButton.disabled = false;
      saveSessionButton.textContent = '💾 Save Session';
    }, 2000);
  }
}

// ── Message Handling ──────────────────────────────────────────
function handleKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
}

async function handleSend() {
  const message = messageInput.value.trim();
  if (!message || sendButton.disabled) return;
  
  clearWelcome();
  
  // Add user message
  addMessage('user', message);
  chatHistory.push({ role: 'user', content: message });
  await saveChatHistory();
  
  // Clear input
  messageInput.value = '';
  autoResize();
  
  // Disable input during request
  sendButton.disabled = true;
  messageInput.disabled = true;
  
  // Show thinking indicator
  const thinkingId = addThinkingMessage();
  
  try {
    // Send to background
    const response = await chrome.runtime.sendMessage({
      action: 'chatMessage',
      message: message,
      context: currentPageContext,
      history: chatHistory.slice(-6), // Last 6 messages for context
      tabId: currentTabId,
    });
    
    // Remove thinking indicator
    removeMessage(thinkingId);
    
    if (response?.error) {
      addMessage('system', `Error: ${response.error}`, { isError: true });
    } else if (response?.reply) {
      // Add assistant message
      const metadata = {
        sources: response.sources,
        actions: response.actions,
      };
      
      addMessage('assistant', response.reply, metadata);
      chatHistory.push({ role: 'assistant', content: response.reply, metadata });
      await saveChatHistory();
      
      // Execute actions if any
      if (response.actions && response.actions.length > 0) {
        await executeActions(response.actions);
      }
    }
  } catch (err) {
    removeMessage(thinkingId);
    addMessage('system', `Connection error: ${err.message}`, { isError: true });
  } finally {
    sendButton.disabled = false;
    messageInput.disabled = false;
    messageInput.focus();
  }
}

// ── Message UI ────────────────────────────────────────────────
function addMessage(role, content, metadata = {}) {
  clearWelcome();
  
  const messageDiv = document.createElement('div');
  messageDiv.className = `hivemind-message ${role}`;
  if (metadata.isError) messageDiv.classList.add('error');
  messageDiv.dataset.id = Date.now();

  // ── Assistant: AI header badge + card + metadata ──────────
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
    messageDiv.appendChild(header);
  }

  const contentDiv = document.createElement('div');
  contentDiv.className = 'hivemind-message-content';
  contentDiv.textContent = content;
  messageDiv.appendChild(contentDiv);

  // ── Metadata footer for assistant ────────────────────────
  if (role === 'assistant' && (metadata.sources || metadata.tokenInfo)) {
    const metaDiv = document.createElement('div');
    metaDiv.className = 'hivemind-message-meta';

    // Sources row
    if (metadata.sources && metadata.sources.length > 0) {
      const sourcesRow = document.createElement('div');
      sourcesRow.className = 'hivemind-sources-row';
      const sourceCount = metadata.sources.length;
      sourcesRow.innerHTML = `
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 6h8M2 3h8M2 9h5"/></svg>
        <span>${sourceCount} SOURCE${sourceCount > 1 ? 'S' : ''} USED</span>
        <span class="hivemind-sources-arrow">›</span>
      `;
      metaDiv.appendChild(sourcesRow);
    }

    // Token row
    const tokensRow = document.createElement('div');
    tokensRow.className = 'hivemind-tokens-row';
    const promptTokens = metadata.promptTokens || Math.round(content.length / 4);
    const completionTokens = metadata.completionTokens || Math.round(content.length / 3.5);
    const totalTokens = metadata.totalTokens || (promptTokens + completionTokens);
    tokensRow.innerHTML = `
      <span><span class="hivemind-token-dot prompt"></span>${promptTokens} prompt</span>
      <span><span class="hivemind-token-dot completion"></span>${completionTokens} completion</span>
      <span><span class="hivemind-token-dot total"></span>${totalTokens} total</span>
    `;
    metaDiv.appendChild(tokensRow);

    messageDiv.appendChild(metaDiv);
  }

  // ── Legacy sources badge (fallback) ───────────────────────
  if (metadata.sources && metadata.sources.length > 0 && !messageDiv.querySelector('.hivemind-message-meta')) {
  messagesContainer.appendChild(messageDiv);
  scrollToBottom();
  
  return messageDiv.dataset.id;
}

function addThinkingMessage() {
  const thinkingDiv = document.createElement('div');
  thinkingDiv.className = 'hivemind-message assistant';
  const thinkingId = Date.now();
  thinkingDiv.dataset.id = thinkingId;
  
  const contentDiv = document.createElement('div');
  contentDiv.className = 'hivemind-thinking';
  contentDiv.innerHTML = '<div class="hivemind-thinking-dot"></div><div class="hivemind-thinking-dot"></div><div class="hivemind-thinking-dot"></div>';
  
  thinkingDiv.appendChild(contentDiv);
  messagesContainer.appendChild(thinkingDiv);
  scrollToBottom();
  
  return thinkingId;
}

function removeMessage(messageId) {
  const message = messagesContainer.querySelector(`[data-id="${messageId}"]`);
  if (message) {
    message.remove();
  }
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function autoResize() {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
}

// ── Action Execution ──────────────────────────────────────────
async function executeActions(actions) {
  for (const action of actions) {
    addMessage('system', `Executing: ${action.type} ${action.target || ''}`);
    
    try {
      const result = await chrome.runtime.sendMessage({
        action: 'executeAction',
        actionType: action.type,
        target: action.target,
        value: action.value,
        tabId: currentTabId,
      });
      
      if (result?.success) {
        addMessage('system', `✓ Action completed: ${action.type}`);
      } else {
        throw new Error(result?.error || 'Action failed');
      }
    } catch (err) {
      addMessage('system', `✗ Action failed: ${err.message}`, { isError: true });
    }
  }
}

// ── Background Message Handler ────────────────────────────────
function handleBackgroundMessage(message, sender, sendResponse) {
  switch (message.action) {
    case 'newMessage':
      // Background notifying of new message (for badge update)
      if (message.message) {
        addMessage(message.role || 'assistant', message.message);
      }
      sendResponse({ received: true });
      break;
    
    case 'contextCaptured':
      // Background notifying context was captured
      if (message.context) {
        currentPageContext = message.context;
        captureButton.classList.add('captured');
        captureButton.textContent = '✓ Captured';
      }
      sendResponse({ received: true });
      break;
    
    default:
      sendResponse({ error: 'Unknown action' });
  }
  
  return true; // Keep channel open for async response
}

// ── Connection Status ─────────────────────────────────────────
function updateConnectionStatus() {
  // First check if API key is configured
  chrome.runtime.sendMessage({ action: 'getConfig' })
    .then(config => {
      if (!config?.apiKey || config.apiKey.length === 0) {
        statusIndicator.classList.add('disconnected');
        statusText.textContent = 'Not Configured';
        return;
      }
      
      // Check if backend is reachable
      return fetch('https://core.hivemind.davinciai.eu:8050/health')
        .then(res => {
          if (res.ok) {
            statusIndicator.classList.remove('disconnected');
            statusText.textContent = 'Connected';
          } else {
            throw new Error('Backend unhealthy');
          }
        });
    })
    .catch(() => {
      statusIndicator.classList.add('disconnected');
      statusText.textContent = 'Offline';
    });
  
  // Re-check every 30 seconds
  setTimeout(updateConnectionStatus, 30000);
}

// ── Initialize on Load ────────────────────────────────────────
init();
