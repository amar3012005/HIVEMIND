/**
 * HIVEMIND Chrome Extension — Popup Script
 */

const $ = (id) => document.getElementById(id);

// ── Init ────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const config = await chrome.storage.local.get(['apiKey', 'apiBase']);

  if (config.apiKey) {
    showConnected(config);
  } else {
    showSetup();
  }
});

// ── Setup View ──────────────────────────────────────────

function showSetup() {
  $('setup').classList.remove('hidden');
  $('connected').classList.add('hidden');

  $('connectBtn').addEventListener('click', async () => {
    const apiKey = $('apiKeyInput').value.trim();
    const apiBase = $('apiBaseInput').value.trim() || 'https://core.hivemind.davinciai.eu:8050';

    if (!apiKey) {
      showStatus('setupStatus', 'Enter your API key', 'error');
      return;
    }

    $('connectBtn').disabled = true;
    $('connectBtn').textContent = 'Connecting...';

    try {
      // Test connection
      const resp = await fetch(`${apiBase}/health`, {
        headers: { 'X-API-Key': apiKey },
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      await chrome.storage.local.set({ apiKey, apiBase });
      showStatus('setupStatus', 'Connected!', 'success');

      setTimeout(() => showConnected({ apiKey, apiBase }), 500);
    } catch (err) {
      showStatus('setupStatus', `Connection failed: ${err.message}`, 'error');
      $('connectBtn').disabled = false;
      $('connectBtn').textContent = 'Connect';
    }
  });
}

// ── Connected View ──────────────────────────────────────

async function showConnected(config) {
  $('setup').classList.add('hidden');
  $('connected').classList.remove('hidden');

  // Load profile stats
  try {
    const resp = await fetch(`${config.apiBase}/api/profile`, {
      headers: { 'X-API-Key': config.apiKey },
    });
    if (resp.ok) {
      const data = await resp.json();
      const profile = data.profile || data;
      $('memoryCount').textContent = profile.memory_count?.toLocaleString() || '0';
      $('obsCount').textContent = profile.observation_count || '0';
    }
  } catch {}

  // Save Page button
  $('savePageBtn').addEventListener('click', async () => {
    $('savePageBtn').disabled = true;
    $('savePageBtn').textContent = '⏳ Saving...';

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await chrome.runtime.sendMessage({ action: 'savePage', tabId: tab.id });

    if (result?.success) {
      showStatus('actionStatus', '✅ Page saved to HIVEMIND', 'success');
      $('savePageBtn').textContent = '✅ Saved!';
    } else {
      showStatus('actionStatus', `❌ ${result?.error || 'Failed'}`, 'error');
      $('savePageBtn').textContent = '📄 Save This Page';
    }
    $('savePageBtn').disabled = false;
    setTimeout(() => { $('savePageBtn').textContent = '📄 Save This Page'; }, 2000);
  });

  // Save Selection button
  $('saveSelectionBtn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.getSelection()?.toString() || '',
      });
      const selection = results[0]?.result;

      if (!selection || selection.length < 5) {
        showStatus('actionStatus', 'Select some text on the page first', 'info');
        return;
      }

      $('saveSelectionBtn').disabled = true;
      const result = await chrome.runtime.sendMessage({
        action: 'saveText',
        content: selection,
        title: `Selection: ${selection.slice(0, 50)}`,
        tags: ['browser-extension', 'selection'],
      });

      if (result?.success) {
        showStatus('actionStatus', '✅ Selection saved', 'success');
      } else {
        showStatus('actionStatus', `❌ ${result?.error || 'Failed'}`, 'error');
      }
      $('saveSelectionBtn').disabled = false;
    } catch (err) {
      showStatus('actionStatus', `❌ ${err.message}`, 'error');
    }
  });

  // Quick Recall
  $('recallBtn').addEventListener('click', doRecall);
  $('recallInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doRecall();
  });

  async function doRecall() {
    const query = $('recallInput').value.trim();
    if (!query) return;

    $('recallBtn').disabled = true;
    const result = await chrome.runtime.sendMessage({ action: 'recall', query });
    $('recallBtn').disabled = false;

    const container = $('recallResults');
    container.innerHTML = '';

    if (result?.memories?.length > 0) {
      result.memories.slice(0, 5).forEach((m) => {
        const div = document.createElement('div');
        div.className = 'recall-item';
        div.innerHTML = `
          <div class="recall-item-title">${escHtml(m.title || m.content?.slice(0, 60) || 'Untitled')}</div>
          <div class="recall-item-score">score: ${(m.score || 0).toFixed(2)}</div>
        `;
        container.appendChild(div);
      });
    } else {
      container.innerHTML = '<div class="recall-item" style="color:#a3a3a3;">No memories found</div>';
    }
  }

  // Disconnect
  $('disconnectBtn').addEventListener('click', async () => {
    await chrome.storage.local.remove(['apiKey', 'apiBase', 'userId']);
    showSetup();
  });
}

// ── Helpers ─────────────────────────────────────────────

function showStatus(elementId, message, type) {
  const el = $(elementId);
  el.className = `status status-${type}`;
  el.textContent = message;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

function escHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
