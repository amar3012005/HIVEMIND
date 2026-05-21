/**
 * HIVEMIND Popup — sign-in via browser OAuth (same flow as @hivemind/cli).
 */

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', async () => {
  const cfg = await chrome.storage.local.get(['apiKey', 'apiBase', 'userEmail']);
  if (cfg.apiKey) {
    renderSignedIn(cfg);
  } else {
    renderSignedOut();
  }
});

function renderSignedOut() {
  $('signedOut').classList.remove('hidden');
  $('signedIn').classList.add('hidden');

  $('signInBtn').addEventListener('click', async () => {
    const btn = $('signInBtn');
    const err = $('signInErr');
    err.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = 'Opening browser…';

    try {
      const resp = await chrome.runtime.sendMessage({
        action: 'signIn',
        apiBase: 'https://api.hivemind.davinciai.eu:8040',
      });
      if (!resp?.success) throw new Error(resp?.error || 'sign-in failed');

      const cfg = await chrome.storage.local.get(['apiKey', 'apiBase', 'userEmail']);
      renderSignedIn(cfg);
    } catch (e) {
      err.textContent = e.message || 'Sign-in failed';
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Sign in with browser';
    }
  });
}

async function renderSignedIn(cfg) {
  $('signedOut').classList.add('hidden');
  $('signedIn').classList.remove('hidden');

  const email = cfg.userEmail || '—';
  $('email').textContent = email;
  $('avatar').textContent = (email[0] || '?').toUpperCase();

  // Profile stats
  try {
    const resp = await fetch(`${cfg.apiBase}/api/profile`, {
      headers: { 'X-API-Key': cfg.apiKey },
    });
    if (resp.ok) {
      const data = await resp.json();
      const p = data.profile || data;
      $('memoryCount').textContent = (p.memory_count ?? 0).toLocaleString();
      $('obsCount').textContent = (p.observation_count ?? 0).toLocaleString();
    }
  } catch {}

  $('openChatBtn').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'openSidePanel' });
    window.close();
  });

  $('signOutBtn').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'signOut' });
    renderSignedOut();
    $('signedOut').classList.remove('hidden');
    $('signedIn').classList.add('hidden');
  });
}
