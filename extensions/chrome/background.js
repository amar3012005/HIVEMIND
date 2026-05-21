/**
 * HIVEMIND Chrome Extension — Background Service Worker
 *
 * Handles:
 * 1. Context menu (right-click "Save to HIVEMIND")
 * 2. Message routing between popup/content scripts and HIVEMIND API
 * 3. Page capture and markdown conversion
 * 4. AI chat session auto-capture (Claude, ChatGPT, Gemini, Perplexity)
 */

// ── Import AI Chat Schemas ──────────────────────────────

importScripts('ai-chat-schemas.js');

// ── Context Menu ────────────────────────────────────────

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
  
  console.log('[hivemind] Extension installed/updated');
});

// ── Side Panel Management ───────────────────────────────────

// Open side panel when extension icon is clicked
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('[hivemind] Side panel setup failed:', error));

// Badge notification system
let unreadCount = 0;

function updateBadge(count) {
  if (count > 0) {
    chrome.action.setBadgeText({ text: count.toString() });
    chrome.action.setBadgeBackgroundColor({ color: '#667eea' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

function clearBadge() {
  unreadCount = 0;
  updateBadge(0);
}

// Clear badge when side panel is opened
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'side-panel') {
    clearBadge();
  }
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
        source: 'browser-extension',
      });
      showBadge('OK', '#22c55e');
    }
  }

  if (info.menuItemId === 'hivemind-save-page') {
    try {
      // Always use the DOM extractors (reliable, no CDP needed).
      // CDP auto-summary was flaky — typing into AI chat inputs often fails.
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['extractors.js'] });
      const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => smartExtract() });
      const pageContent = results[0]?.result;
      if (!pageContent) {
        showBadge('ERR', '#ef4444');
        return;
      }
      
      // If it's an AI chat platform, enrich with metadata
      if (isAIChatPlatform(tab.url)) {
        pageContent.tags = [...(pageContent.tags || []), 'ai-chat'];
      }
      
      await saveToHivemind(config, {
        content: pageContent.content,
        title: pageContent.title || tab.title,
        tags: ['browser-extension', ...(pageContent.tags || []), `url:${tab.url}`],
        source: pageContent.platform || 'browser-extension',
      });
      showBadge('✓', '#22c55e');
    } catch (err) {
      console.error('[context-menu] Save page failed:', err);
      showBadge('ERR', '#ef4444');
    }
  }
});

// ── Message Handler ─────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'savePage') {
    handleSavePage(message.tabId).then(sendResponse);
    return true; // async
  }

  if (message.action === 'saveText') {
    getConfig().then(config => {
      saveToHivemind(config, {
        content: message.content,
        title: message.title || 'Saved from browser',
        tags: message.tags || ['browser-extension'],
        source: 'browser-extension',
      }).then(result => sendResponse(result));
    });
    return true;
  }

  if (message.action === 'recall') {
    getConfig().then(config => {
      recallFromHivemind(config, message.query).then(sendResponse);
    });
    return true;
  }

  if (message.action === 'getProfile') {
    getConfig().then(config => {
      getProfile(config).then(sendResponse);
    });
    return true;
  }

  if (message.action === 'getConfig') {
    getConfig().then(sendResponse);
    return true;
  }

  // ── NEW: Chat & CDP Integration ────────────────────────

  if (message.action === 'captureContext') {
    handleCaptureContext(sender.tab.id).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.action === 'chatMessage') {
    handleChatMessage(message, sender.tab?.id || message.tabId).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.action === 'chatMessageStream') {
    // SSE chat — side panel listens for chunks via runtime.onMessage
    handleChatStream(message, sender).catch(err => {
      try { chrome.runtime.sendMessage({ action: 'chatStreamChunk', streamId: message.streamId, event: { type: 'error', error: err.message } }); } catch {}
    });
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === 'captureAISession') {
    // Explicit request to capture AI chat session
    getConfig().then(async config => {
      const tabId = message.tabId || sender.tab?.id;
      if (!tabId) {
        sendResponse({ error: 'No tab ID provided' });
        return;
      }
      
      const tab = await chrome.tabs.get(tabId);
      const url = tab.url;
      
      if (!isAIChatPlatform(url)) {
        sendResponse({ error: 'Not an AI chat platform' });
        return;
      }
      
      try {
        const result = await captureAIChatSession(tabId, url, config);
        sendResponse(result);
      } catch (err) {
        console.warn('[captureAISession] Failed, trying fallback extraction');
        // Fallback to standard extraction
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['extractors.js'] });
          const results = await chrome.scripting.executeScript({ target: { tabId }, func: () => smartExtract() });
          const pageContent = results[0]?.result;
          if (pageContent) {
            await saveToHivemind(config, {
              content: pageContent.content,
              title: pageContent.title || tab.title,
              tags: ['browser-extension', 'ai-chat-fallback', ...(pageContent.tags || []), `url:${url}`],
              source: pageContent.platform || 'browser-extension',
            });
            sendResponse({ success: true, fallback: true });
          } else {
            sendResponse({ error: 'Extraction failed' });
          }
        } catch (fallbackErr) {
          sendResponse({ error: fallbackErr.message });
        }
      }
    });
    return true;
  }

  if (message.action === 'executeAction') {
    handleExecuteAction(message, sender.tab.id).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.action === 'saveToMemory') {
    getConfig().then(config => {
      // Route through canonical memory pipeline (smart ingest router)
      fetch(`${config.apiBase}/api/memories`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': config.apiKey,
        },
        body: JSON.stringify({
          content: message.content,
          title: message.title || 'Browser chat',
          tags: message.tags || ['browser-chat', 'browser-extension'],
          memory_type: 'note',
          source_metadata: {
            source_platform: 'browser-extension',
            url: message.url || '',
          },
        }),
      })
      .then(r => r.json())
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    });
    return true;
  }

  if (message.action === 'toggleChat') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'toggleChat' });
      }
    });
    return false;
  }

  if (message.action === 'signIn') {
    handleSignIn(message.apiBase).then(sendResponse).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (message.action === 'signOut') {
    chrome.storage.local.remove(['apiKey', 'apiBase', 'userId', 'userEmail', 'orgId']).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.action === 'getSelectionContext') {
    getSelectionContext().then(sendResponse).catch(() => sendResponse(null));
    return true;
  }

  if (message.action === 'startSectionPicker') {
    startSectionPicker().then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === 'sectionPicked') {
    // Forwarded from content script — broadcast to side panel.
    try { chrome.runtime.sendMessage({ action: 'sectionContextReady', section: message.section }); } catch {}
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === 'openSidePanel') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) await chrome.sidePanel.open({ tabId: tab.id });
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
});

// ── Selection + Section context capture ───────────────────

async function getSelectionContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const sel = (window.getSelection?.() || '').toString().trim();
        if (!sel || sel.length < 12) return null;
        return {
          mode: 'selection',
          text: sel.slice(0, 6000),
          url: location.href,
          title: document.title,
          length: sel.length,
        };
      },
    });
    return result || null;
  } catch {
    return null;
  }
}

async function startSectionPicker() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('no active tab');
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => { try { window.__hivemindStartSectionPicker?.(); } catch (e) {} },
  });
  return { ok: true };
}

// ── Chat SSE stream (ReAct agent tool timeline) ───────────

async function handleChatStream(message, sender) {
  const config = await getConfig();
  if (!config.apiKey) throw new Error('Not signed in');

  const { streamId, message: userMessage, history = [], context = null } = message;

  const emit = (event) => {
    try {
      chrome.runtime.sendMessage({ action: 'chatStreamChunk', streamId, event });
    } catch {}
  };

  let fullMessage = userMessage;
  if (context) {
    if (context.mode === 'selection') {
      fullMessage =
        `<METADATA:SELECTION>\n` +
        `URL: ${context.url}\nTitle: ${context.title}\n` +
        `User is asking about THIS SELECTED TEXT only (not the full page):\n${(context.text || '').slice(0, 6000)}\n` +
        `</METADATA:SELECTION>\n\n${userMessage}`;
    } else if (context.mode === 'section') {
      fullMessage =
        `<METADATA:SECTION>\n` +
        `URL: ${context.url}\nTitle: ${context.title}\n` +
        `Section: ${context.heading || context.selector || 'unnamed'}\n` +
        `User is asking about THIS PAGE SECTION only:\n${(context.text || '').slice(0, 6000)}\n` +
        `</METADATA:SECTION>\n\n${userMessage}`;
    } else if (context.mode === 'page' || context.url) {
      // Whole page — re-extract live to keep payload fresh
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['extractors.js'] });
          const [{ result: ex }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => smartExtract() });
          fullMessage =
            `<METADATA:BROWSER_CONTEXT>\n` +
            `URL: ${tab.url}\nTitle: ${tab.title}\n` +
            `Page:\n${(ex?.content || '').slice(0, 6000)}\n` +
            `</METADATA:BROWSER_CONTEXT>\n\n${userMessage}`;
        }
      } catch {}
    } else if (context.textContent) {
      fullMessage = `<METADATA:BROWSER_CONTEXT>\nURL: ${context.url}\nTitle: ${context.title}\nPage:\n${context.textContent.slice(0, 4000)}\n</METADATA:BROWSER_CONTEXT>\n\n${userMessage}`;
    }
  }

  const resp = await fetch(`${config.apiBase}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.apiKey,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      message: fullMessage,
      history,
      stream: true,
      browser_origin: Boolean(context),
    }),
  });

  if (!resp.ok || !resp.body) {
    emit({ type: 'error', error: `HTTP ${resp.status}` });
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      try { emit(JSON.parse(payload)); } catch {}
    }
  }
}

// ── OAuth Sign-in (browser flow, like @hivemind/cli) ───────

async function handleSignIn(apiBaseOverride) {
  const apiBase = apiBaseOverride || 'https://api.hivemind.davinciai.eu:8040';
  const redirectUri = chrome.identity.getRedirectURL('cb');
  const state = crypto.randomUUID().replace(/-/g, '');

  const startUrl = `${apiBase}/auth/cli/start?callback=${encodeURIComponent(redirectUri)}&state=${state}`;

  const finalUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: startUrl, interactive: true },
      (responseUrl) => {
        if (chrome.runtime.lastError || !responseUrl) {
          reject(new Error(chrome.runtime.lastError?.message || 'auth cancelled'));
        } else {
          resolve(responseUrl);
        }
      }
    );
  });

  const parsed = new URL(finalUrl);
  const token = parsed.searchParams.get('token');
  const echoState = parsed.searchParams.get('state');
  const userEmail = parsed.searchParams.get('user_email') || '';
  const userId = parsed.searchParams.get('user_id') || '';
  const orgId = parsed.searchParams.get('org_id') || '';

  if (!token) throw new Error('no token in callback');
  if (echoState !== state) throw new Error('state mismatch — possible CSRF');

  // core API base for memory/chat ops
  const coreApiBase = 'https://core.hivemind.davinciai.eu:8050';
  await chrome.storage.local.set({
    apiKey: token,
    apiBase: coreApiBase,
    controlPlaneBase: apiBase,
    userEmail,
    userId,
    orgId,
  });

  return { success: true, userEmail, userId, orgId };
}

// ── API Functions ───────────────────────────────────────

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
          source_type: 'browser-extension',
          source_platform: memory.source || 'browser-extension',
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

async function getProfile(config) {
  try {
    const resp = await fetch(`${config.apiBase}/api/profile`, {
      headers: { 'X-API-Key': config.apiKey },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.profile || data;
  } catch {
    return null;
  }
}

async function handleSavePage(tabId) {
  const config = await getConfig();
  if (!config.apiKey) return { success: false, error: 'No API key configured' };

  try {
    const tab = await chrome.tabs.get(tabId);
    // Inject smart extractor + execute
    await chrome.scripting.executeScript({ target: { tabId }, files: ['extractors.js'] });
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: () => smartExtract() });
    const pageContent = results[0]?.result;
    if (!pageContent) return { success: false, error: 'Could not capture page' };

    return saveToHivemind(config, {
      content: pageContent.content,
      title: pageContent.title || tab.title,
      tags: ['browser-extension', ...(pageContent.tags || []), `url:${tab.url}`],
      source: pageContent.platform || 'browser-extension',
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Page capture now handled by extractors.js (smartExtract)

// ── Badge Helper ────────────────────────────────────────

function showBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);
}

// ─────────────────────────────────────────────────────────────────────────────
// CDP Integration & Chat Functions (Kimi-inspired architecture)
// ─────────────────────────────────────────────────────────────────────────────

// ── CDP Helper Functions ────────────────────────────────

const attachedTabs = new Map(); // Track which tabs have CDP attached
let contextCache = new Map(); // Cache contexts for 30 seconds

async function attachDebugger(tabId) {
  if (attachedTabs.has(tabId)) return;
  
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.set(tabId, true);
    
    // Auto-detach on debugger disconnect
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (source.tabId === tabId) {
        attachedTabs.delete(tabId);
      }
    });
  } catch (err) {
    if (!err.message.includes('already attached')) {
      throw err;
    }
  }
}

async function sendCommand(tabId, method, params = {}) {
  await attachDebugger(tabId);
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

// ── AI Chat Session Capture (CDP Automation) ────────────

/**
 * Execute fill action via CDP using a CSS selector (contenteditable or textarea).
 * Pure-selector form. The action dispatcher uses executeFill (defined below) which
 * also resolves @e<N> element-refs.
 */
async function executeFillSelector(tabId, selector, value) {
  try {
    const result = await sendCommand(tabId, 'Runtime.evaluate', {
      expression: `
        (function() {
          let el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { error: 'Element not found: ${selector}' };
          
          el.focus();
          
          // Handle contenteditable
          if (el.isContentEditable) {
            const sel = window.getSelection();
            if (sel) {
              const range = document.createRange();
              range.selectNodeContents(el);
              sel.removeAllRanges();
              sel.addRange(range);
            }
            let inserted = false;
            try {
              inserted = document.execCommand('insertText', false, ${JSON.stringify(value)});
            } catch (e) {}
            if (!inserted) {
              el.textContent = ${JSON.stringify(value)};
              el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ${JSON.stringify(value)}, bubbles: true }));
            }
            return { success: true, mode: 'contenteditable' };
          }
          
          // Handle textarea/input
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set ||
                               Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
          if (nativeSetter) {
            nativeSetter.call(el, ${JSON.stringify(value)});
          } else {
            el.value = ${JSON.stringify(value)};
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, mode: 'value' };
        })()
      `,
      returnByValue: true,
      awaitPromise: false,
    });
    
    if (result.result?.value?.error) {
      throw new Error(result.result.value.error);
    }
    
    return result.result?.value || { success: true };
  } catch (err) {
    console.error('[executeFillSelector]', err);
    throw err;
  }
}

/**
 * Execute sendKeys via CDP (press Enter)
 */
async function executeSendKeys(tabId, key) {
  const keyMap = {
    'Enter': { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
    'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
  };
  
  const spec = keyMap[key];
  if (!spec) throw new Error(`Unknown key: ${key}`);
  
  try {
    await sendCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      ...(spec.text ? { text: spec.text } : {}),
    });
    
    await sendCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
    });
    
    return { success: true };
  } catch (err) {
    console.error('[executeSendKeys]', err);
    throw err;
  }
}

/**
 * Execute JavaScript and return result
 */
async function executeEvaluate(tabId, script) {
  try {
    const result = await sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    });
    
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Evaluation failed');
    }
    
    return result.result?.value;
  } catch (err) {
    console.error('[executeEvaluate]', err);
    throw err;
  }
}

/**
 * Wait for element to appear or change
 */
async function waitForNewMessage(tabId, selector, previousCount, timeout = 45000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    const currentCount = await executeEvaluate(tabId, `
      document.querySelectorAll(${JSON.stringify(selector)}).length
    `);
    
    if (currentCount > previousCount) {
      // Wait a bit more to ensure message is fully rendered
      await new Promise(resolve => setTimeout(resolve, 1000));
      return true;
    }
    
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  
  throw new Error('Timeout waiting for new message');
}

/**
 * Capture AI chat session — inject summary prompt into the page DOM.
 * No CDP/debugger required — uses chrome.scripting.executeScript to:
 * 1. Find the chat input field
 * 2. Type the summary prompt
 * 3. Click the send button
 * 4. Wait for the AI response
 * 5. Extract conversation + summary
 */
async function captureAIChatSession(tabId, url, config) {
  const platform = detectAIChatPlatform(url);
  if (!platform) {
    throw new Error('Not an AI chat platform');
  }
  
  console.log(`[ai-chat-capture] Starting DOM-injection capture for ${platform.name} on tab ${tabId}`);
  
  // Update badge
  chrome.action.setBadgeText({ text: '🤖', tabId });
  chrome.action.setBadgeBackgroundColor({ color: platform.color, tabId });
  
  try {
    // ── Step 1: Count messages before injecting ──────────
    const [{ result: countResult }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (selector) => document.querySelectorAll(selector).length,
      args: [platform.selectors.messages],
    });
    const messagesBefore = countResult || 0;
    console.log(`[ai-chat-capture] Messages before: ${messagesBefore}`);
    
    // ── Step 2: Inject summary prompt into input ─────────
    const [{ result: fillResult }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (inputSelector, fallbackSelector, prompt) => {
        // Find the chat input — Claude uses contenteditable, ChatGPT uses textarea
        let input = document.querySelector(inputSelector);
        if (!input) input = document.querySelector(fallbackSelector);
        if (!input) {
          // Last resort: find ANY contenteditable or textarea in the page
          input = document.querySelector('[contenteditable="true"]') 
               || document.querySelector('textarea')
               || document.querySelector('[role="textbox"]');
        }
        if (!input) return { error: 'input_not_found' };
        
        const tag = input.tagName.toLowerCase();
        const isEditable = input.isContentEditable || tag === 'div' || tag === 'p';
        
        if (isEditable) {
          // ContentEditable approach
          input.focus();
          input.textContent = prompt;
          // Dispatch input event so React/Vue/etc pick it up
          input.dispatchEvent(new InputEvent('input', { 
            inputType: 'insertText', 
            data: prompt, 
            bubbles: true 
          }));
          // Also try execCommand for fallback
          document.execCommand('selectAll', false);
          document.execCommand('insertText', false, prompt);
          return { success: true, mode: 'contenteditable', tag };
        } else {
          // Textarea/input approach
          input.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
          )?.set || Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          )?.set;
          if (nativeSetter) {
            nativeSetter.call(input, prompt);
          } else {
            input.value = prompt;
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, mode: 'textarea', tag };
        }
      },
      args: [platform.selectors.input, platform.selectors.inputFallback, platform.summaryPrompt],
    });
    
    if (fillResult?.error) {
      throw new Error(`Input not found: ${fillResult.error}`);
    }
    console.log(`[ai-chat-capture] Input filled: ${fillResult?.mode} (${fillResult?.tag})`);
    
    // ── Step 3: Wait briefly for UI to register input ────
    await new Promise(r => setTimeout(r, 500));
    
    // ── Step 4: Click the send button ───────────────────
    const [{ result: clickResult }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (submitSelector, fallbackSelector) => {
        let btn = document.querySelector(submitSelector);
        if (!btn) btn = document.querySelector(fallbackSelector);
        if (!btn) {
          // Try to find any submit-looking button
          btn = document.querySelector('button[aria-label*="Send" i]')
             || document.querySelector('button[aria-label*="send" i]')
             || document.querySelector('button:has(svg)');
        }
        if (!btn) return { error: 'send_button_not_found' };
        btn.click();
        return { success: true };
      },
      args: [platform.selectors.submit, platform.selectors.submitFallback],
    });
    
    if (clickResult?.error) {
      throw new Error(`Send button not found: ${clickResult.error}`);
    }
    console.log('[ai-chat-capture] Send button clicked');
    
    // ── Step 5: Wait for AI response ────────────────────
    chrome.action.setBadgeText({ text: '⏳', tabId });
    
    const startTime = Date.now();
    const timeout = platform.waitForResponse?.timeout || 30000;
    const interval = platform.waitForResponse?.checkInterval || 1000;
    let gotResponse = false;
    
    while (Date.now() - startTime < timeout) {
      await new Promise(r => setTimeout(r, interval));
      
      const [{ result: currentCount }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector) => document.querySelectorAll(selector).length,
        args: [platform.selectors.messages],
      });
      
      // Also check if thinking indicator disappeared
      if (platform.waitForResponse?.thinkingIndicator) {
        const [{ result: thinkingGone }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: (sel) => !document.querySelector(sel),
          args: [platform.waitForResponse.thinkingIndicator],
        });
        if (!thinkingGone) continue; // Still thinking
      }
      
      if (currentCount > messagesBefore) {
        // Wait a bit more for full render
        await new Promise(r => setTimeout(r, 1500));
        gotResponse = true;
        break;
      }
    }
    
    if (!gotResponse) {
      console.warn('[ai-chat-capture] Timed out waiting for response — grabbing current state');
    }
    
    // ── Step 6: Extract chat history + summary ───────────
    const [{ result: extractionResult }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (chatHistoryScript, lastMessageScript) => {
        try {
          const chatHistoryFn = new Function(`return (${chatHistoryScript})();`);
          const lastMsgFn = new Function(`return (${lastMessageScript})();`);
          return {
            chatHistory: chatHistoryFn(),
            lastMessage: lastMsgFn(),
          };
        } catch (e) {
          return { chatHistory: [], lastMessage: null, error: e.message };
        }
      },
      args: [platform.extraction.chatHistoryScript, platform.extraction.lastMessageScript],
    });
    
    const chatHistory = extractionResult?.chatHistory || [];
    const summary = extractionResult?.lastMessage || '(No summary received)';
    
    console.log(`[ai-chat-capture] Extracted ${chatHistory.length} messages`);
    
    // ── Step 7: Format and save ─────────────────────────
    const content = [
      `## 🤖 AI-Generated Session Summary`,
      ``,
      summary,
      ``,
      `## 📜 Full Conversation (${chatHistory.length} messages)`,
      ``,
      ...chatHistory.map((msg, i) => 
        `### ${msg.role === 'user' ? '👤 User' : '🤖 AI'}\n\n${msg.content}\n`
      ),
    ].join('\n').slice(0, 32000);
    
    await saveToHivemind(config, {
      content,
      title: `${platform.name} Session — ${new Date().toLocaleString()}`,
      tags: ['ai-chat', platform.name.toLowerCase(), 'auto-summary', `url:${url}`],
      source: platform.name.toLowerCase(),
    });
    
    // Success badge
    chrome.action.setBadgeText({ text: '✅', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e', tabId });
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }), 3000);
    
    return { 
      success: true, 
      platform: platform.name, 
      messageCount: chatHistory.length,
    };
    
  } catch (err) {
    console.error('[ai-chat-capture] Failed:', err);
    chrome.action.setBadgeText({ text: '❌', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444', tabId });
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }), 3000);
    throw err;
  }
}

// ── Context Capture (CDP Snapshot) ──────────────────────

async function handleCaptureContext(tabId) {
  // Check cache first
  const cached = contextCache.get(tabId);
  if (cached && (Date.now() - cached.timestamp < 30000)) {
    return cached.context;
  }
  
  try {
    await attachDebugger(tabId);
    
    // Enable Accessibility domain
    await sendCommand(tabId, 'Accessibility.enable');
    
    // Get accessibility tree
    const { nodes } = await sendCommand(tabId, 'Accessibility.getFullAXTree');
    
    // Get current URL
    const { result: urlResult } = await sendCommand(tabId, 'Runtime.evaluate', {
      expression: 'window.location.href',
      returnByValue: true,
    });
    
    // Get page title
    const { result: titleResult } = await sendCommand(tabId, 'Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
    
    // Extract readable text content (like Kimi does)
    const { result: textResult } = await sendCommand(tabId, 'Runtime.evaluate', {
      expression: `
        (function() {
          // Extract visible text from main content areas
          const main = document.querySelector('main, article, [role="main"], .content, #content, .post, .article');
          const target = main || document.body;
          
          // Get all text nodes and visible elements
          const textContent = [];
          const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
            acceptNode: function(node) {
              const parent = node.parentElement;
              if (!parent) return NodeFilter.FILTER_REJECT;
              // Skip hidden elements, scripts, styles
              if (parent.offsetParent === null || 
                  ['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK'].includes(parent.tagName)) {
                return NodeFilter.FILTER_REJECT;
              }
              const text = node.textContent.trim();
              return text.length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            }
          });
          
          let node;
          while (node = walker.nextNode()) {
            const text = node.textContent.trim();
            if (text.length > 3) textContent.push(text);
          }
          
          // Deduplicate and join
          const uniqueText = [...new Set(textContent)];
          return uniqueText.join(' ').slice(0, 8000); // Limit to 8KB
        })()
      `,
      returnByValue: true,
    });
    
    // Extract interactive elements
    const interactiveElements = extractInteractiveElements(nodes);
    
    // Build context object
    const context = {
      url: urlResult.value,
      title: titleResult.value,
      timestamp: new Date().toISOString(),
      interactiveElements: interactiveElements,
      elementCount: interactiveElements.length,
      textContent: textResult.value || '',
      textLength: (textResult.value || '').length,
    };
    
    // Cache for 30 seconds
    contextCache.set(tabId, {
      context: context,
      timestamp: Date.now(),
    });
    
    return context;
  } catch (err) {
    console.error('[CDP] Context capture failed:', err);
    throw new Error(`Context capture failed: ${err.message}`);
  }
}

function extractInteractiveElements(nodes) {
  const interactive = [];
  const interactiveRoles = [
    'button', 'link', 'textbox', 'searchbox', 'combobox',
    'checkbox', 'radio', 'menuitem', 'tab', 'switch',
  ];
  
  nodes.forEach((node, index) => {
    if (!node.role) return;
    
    const role = node.role.value.toLowerCase();
    if (interactiveRoles.includes(role)) {
      interactive.push({
        ref: `@e${interactive.length + 1}`,
        role: role,
        name: node.name?.value || '',
        description: node.description?.value || '',
        backendDOMNodeId: node.backendDOMNodeId,
      });
    }
  });
  
  return interactive.slice(0, 100); // Limit to 100 elements
}

// ── Chat Message Handler ────────────────────────────────

async function handleChatMessage(message, tabId) {
  const config = await getConfig();
  if (!config.apiKey) {
    throw new Error('No API key configured. Please click the extension icon to configure your HIVEMIND API key.');
  }
  
  const { message: userMessage, context, history } = message;
  
  // Prepare browser context summary for HIVEMIND.
  // <METADATA> tags tell backend to ignore page context for fact extraction
  // while still preserving it for response generation.
  let browserContext = '';
  if (context) {
    browserContext = `\n\n<METADATA:BROWSER_CONTEXT>\n━━━ BROWSER PAGE CONTEXT ━━━\nThis is live browser context from the current page. Element references like [el:1] point to page elements in this tab.\n\nURL: ${context.url}\nTitle: ${context.title}\n`;
    
    // Add readable text content first (what the user sees)
    if (context.textContent && context.textContent.length > 50) {
      browserContext += `\nVisible Page Text:\n${context.textContent.slice(0, 6000)}\n`;
    }
    
    // Add interactive elements for browser actions.
    if (context.interactiveElements && context.interactiveElements.length > 0) {
      browserContext += `\n━━━ Interactive Elements (Browser Actions) ━━━\n`;
      const topElements = context.interactiveElements.slice(0, 15);
      browserContext += topElements.map((el, idx) => 
        `[el:${idx + 1}] ${el.role} - "${el.name || el.description}"`
      ).join('\n');
      browserContext += '\n\nTo execute browser actions: "ACTION: click [el:5]" or "ACTION: fill [el:3] with text" or "ACTION: navigate URL"';
    }
    browserContext += '\n</METADATA:BROWSER_CONTEXT>\n';
  }
  
  // Prepend browser context so the backend can answer with page awareness.
  const fullMessage = browserContext + '\n\n' + userMessage;
  
  // Call HIVEMIND chat API (/api/chat with full memory integration)
  try {
    const resp = await fetch(`${config.apiBase}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.apiKey,
      },
      body: JSON.stringify({
        message: fullMessage,
        model: 'llama-3.3-70b-versatile',
        browser_origin: Boolean(context),
        history: history || [],
      }),
    });
    
    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`API error: ${resp.status} ${errorText.slice(0, 200)}`);
    }
    
    const data = await resp.json();
    
    // Parse actions from AI response
    const actions = parseActions(data.response, context);
    
    return {
      reply: data.response,
      sources: data.sources || [],
      actions: actions,
    };
  } catch (err) {
    throw new Error(`Chat failed: ${err.message}`);
  }
}

// ── Action Parser ───────────────────────────────────────

function parseActions(reply, context) {
  if (!context || !reply) return [];
  
  // Match ACTION: <type> <target> [value]
  // Support both @e5 and [el:5] formats.
  const actionPattern = /ACTION:\s*(\w+)\s+((?:@e|\[el:)\d+\]?|https?:\/\/\S+|\S+)(?:\s+(.+))?/gim;
  const actions = [];
  let match;
  
  while ((match = actionPattern.exec(reply)) !== null) {
    const [, type, target, value] = match;
    // Normalize [el:5] -> @e5 for internal processing.
    const normalizedTarget = target.replace(/\[el:(\d+)\]/, '@e$1');
    actions.push({
      type: type.toLowerCase(),
      target: normalizedTarget,
      value: value || '',
    });
  }
  
  return actions;
}

// ── Action Executor ─────────────────────────────────────

async function handleExecuteAction(message, tabId) {
  const { actionType, target, value } = message;
  
  await attachDebugger(tabId);
  
  try {
    switch (actionType) {
      case 'click':
        return await executeClick(tabId, target);
      case 'fill':
        return await executeFill(tabId, target, value);
      case 'navigate':
        return await executeNavigate(tabId, target);
      default:
        throw new Error(`Unknown action type: ${actionType}`);
    }
  } catch (err) {
    throw new Error(`Action execution failed: ${err.message}`);
  }
}

async function executeClick(tabId, target) {
  // If target is @e reference, resolve to element
  if (target.startsWith('@e')) {
    const cached = contextCache.get(tabId);
    if (!cached) throw new Error('No context available, refresh page context');
    
    const elementRef = target;
    const element = cached.context.interactiveElements.find(el => el.ref === elementRef);
    if (!element) throw new Error(`Element ${elementRef} not found`);
    
    // Resolve backendDOMNodeId to objectId
    const { object } = await sendCommand(tabId, 'DOM.resolveNode', {
      backendNodeId: element.backendDOMNodeId,
    });
    
    if (!object || !object.objectId) {
      throw new Error('Could not resolve element to DOM node');
    }
    
    // Scroll into view
    await sendCommand(tabId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() { this.scrollIntoView({ block: 'center' }); }`,
    });
    
    // Get element position
    const { model } = await sendCommand(tabId, 'DOM.getBoxModel', {
      objectId: object.objectId,
    });
    
    if (!model || !model.content || model.content.length < 8) {
      throw new Error('Element has no layout box');
    }
    
    const [x1, y1, x2, y2, x3, y3, x4, y4] = model.content;
    const x = (x1 + x2 + x3 + x4) / 4;
    const y = (y1 + y2 + y3 + y4) / 4;
    
    // Click via CDP
    await sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: x,
      y: y,
      button: 'left',
      clickCount: 1,
    });
    
    await sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: x,
      y: y,
      button: 'left',
      clickCount: 1,
    });
    
    return { success: true, x: Math.round(x), y: Math.round(y) };
  } else {
    // CSS selector fallback
    const { result } = await sendCommand(tabId, 'Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(target)})?.click()`,
    });
    
    return { success: true };
  }
}

async function executeFill(tabId, target, value) {
  // Similar logic to click but uses Input.insertText
  if (target.startsWith('@e')) {
    const cached = contextCache.get(tabId);
    if (!cached) throw new Error('No context available');
    
    const element = cached.context.interactiveElements.find(el => el.ref === target);
    if (!element) throw new Error(`Element ${target} not found`);
    
    const { object } = await sendCommand(tabId, 'DOM.resolveNode', {
      backendNodeId: element.backendDOMNodeId,
    });
    
    // Focus element first
    await sendCommand(tabId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() { this.focus(); this.value = ''; }`,
    });
    
    // Type text
    await sendCommand(tabId, 'Input.insertText', { text: value });
    
    return { success: true, filled: value.length };
  } else {
    // CSS selector fallback
    await sendCommand(tabId, 'Runtime.evaluate', {
      expression: `
        const el = document.querySelector(${JSON.stringify(target)});
        if (el) {
          el.focus();
          el.value = ${JSON.stringify(value)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      `,
    });
    
    return { success: true };
  }
}

async function executeNavigate(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  return { success: true, navigatedTo: url };
}

// ── Keyboard Shortcut ───────────────────────────────────

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-chat') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'toggleChat' });
      }
    });
  }
});
