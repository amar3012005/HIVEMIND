/**
 * HIVEMIND Chrome Extension — Background Service Worker
 *
 * Handles:
 * 1. Context menu (right-click "Save to HIVEMIND")
 * 2. Message routing between popup/content scripts and HIVEMIND API
 * 3. Page capture and markdown conversion
 */

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
      // Inject smart extractor + execute
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['extractors.js'] });
      const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => smartExtract() });
      const pageContent = results[0]?.result;
      if (pageContent) {
        await saveToHivemind(config, {
          content: pageContent.content,
          title: pageContent.title || tab.title,
          tags: ['browser-extension', ...(pageContent.tags || []), `url:${tab.url}`],
          source: pageContent.platform || 'browser-extension',
        });
        showBadge('OK', '#22c55e');
      }
    } catch (err) {
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
});

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
