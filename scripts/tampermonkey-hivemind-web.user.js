// ==UserScript==
// @name         HIVE-MIND Webapp Bridge
// @namespace    http://localhost:3000/
// @version      0.1.0
// @description  Inject HIVE-MIND memory recall and save actions into ChatGPT and Gemini pages via localhost.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://gemini.google.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function () {
  'use strict';

  const STORE = {
    baseUrl: 'hivemind_base_url',
    apiKey: 'hivemind_api_key',
    project: 'hivemind_project'
  };

  const defaults = {
    baseUrl: GM_getValue(STORE.baseUrl, 'http://localhost:3000'),
    apiKey: GM_getValue(STORE.apiKey, 'hmk_live_5bd201c987655495883abfd768c6a2b3757c3901ade829ab'),
    project: GM_getValue(STORE.project, 'atlas')
  };

  function detectPlatform() {
    if (location.hostname.includes('gemini')) return 'gemini';
    return 'chatgpt';
  }

  function splitCsv(value) {
    return `${value || ''}`.split(',').map(item => item.trim()).filter(Boolean);
  }

  async function api(path, body) {
    const response = await fetch(`${defaults.baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${defaults.apiKey}`
      },
      body: JSON.stringify(body)
    });

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      throw new Error(data?.message || data?.error || `HTTP ${response.status}`);
    }

    return data;
  }

  function querySelectors(selectors) {
    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector)).filter(node => node.textContent && node.textContent.trim());
      if (nodes.length > 0) return nodes;
    }
    return [];
  }

  function getUserPrompt() {
    const selectors = detectPlatform() === 'gemini'
      ? ['div[contenteditable="true"]', 'textarea']
      : ['#prompt-textarea', 'textarea', 'div[contenteditable="true"]'];

    const nodes = querySelectors(selectors);
    if (nodes[0]) {
      return nodes[0].textContent.trim() || nodes[0].value || '';
    }
    return '';
  }

  function getLastAssistantMessage() {
    const selectors = detectPlatform() === 'gemini'
      ? ['message-content .markdown', 'message-content', '.response-container']
      : ['[data-message-author-role="assistant"]', '.markdown.prose', 'article'];

    const nodes = querySelectors(selectors);
    return nodes.length > 0 ? nodes[nodes.length - 1].textContent.trim() : '';
  }

  function insertAtCursor(text) {
    const selectors = detectPlatform() === 'gemini'
      ? ['div[contenteditable="true"]', 'textarea']
      : ['#prompt-textarea', 'textarea', 'div[contenteditable="true"]'];
    const input = querySelectors(selectors)[0];
    if (!input) return;

    if ('value' in input) {
      const existing = input.value || '';
      input.value = existing ? `${existing}\n\n${text}` : text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    input.textContent = (input.textContent || '').trim()
      ? `${input.textContent.trim()}\n\n${text}`
      : text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'hivemind-web-bridge';
    panel.innerHTML = `
      <div class="hm-head">
        <strong>HIVE-MIND</strong>
        <button id="hm-toggle" type="button">Hide</button>
      </div>
      <label>Project</label>
      <input id="hm-project" value="${defaults.project}" />
      <label>Preferred Tags</label>
      <input id="hm-tags" value="deploy" />
      <div class="hm-actions">
        <button id="hm-recall" type="button">Recall To Prompt</button>
        <button id="hm-save" type="button">Save Last Answer</button>
      </div>
      <label>Output</label>
      <pre id="hm-output">Ready.</pre>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #hivemind-web-bridge {
        position: fixed;
        right: 16px;
        bottom: 16px;
        width: 320px;
        z-index: 999999;
        background: rgba(19, 18, 16, 0.94);
        color: #f5efe5;
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 16px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.35);
        padding: 14px;
        font: 12px/1.4 ui-sans-serif, system-ui, sans-serif;
      }
      #hivemind-web-bridge .hm-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 10px;
      }
      #hivemind-web-bridge label {
        display: block;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: #c0b6a8;
        margin: 8px 0 4px;
      }
      #hivemind-web-bridge input, #hivemind-web-bridge button {
        width: 100%;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.12);
        padding: 8px 10px;
        font: inherit;
      }
      #hivemind-web-bridge input {
        background: rgba(255,255,255,0.08);
        color: #fff;
      }
      #hivemind-web-bridge .hm-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-top: 10px;
      }
      #hivemind-web-bridge button {
        cursor: pointer;
        background: #d36b2d;
        color: #130f0a;
        font-weight: 700;
      }
      #hivemind-web-bridge #hm-toggle {
        width: auto;
        background: transparent;
        color: #f5efe5;
      }
      #hivemind-web-bridge pre {
        margin: 0;
        max-height: 180px;
        overflow: auto;
        background: rgba(255,255,255,0.06);
        border-radius: 12px;
        padding: 10px;
        white-space: pre-wrap;
      }
      #hivemind-web-bridge.hm-collapsed > :not(.hm-head) {
        display: none;
      }
    `;

    document.documentElement.appendChild(style);
    document.body.appendChild(panel);

    const output = panel.querySelector('#hm-output');
    const projectInput = panel.querySelector('#hm-project');
    const tagsInput = panel.querySelector('#hm-tags');

    projectInput.addEventListener('change', () => {
      defaults.project = projectInput.value.trim();
      GM_setValue(STORE.project, defaults.project);
    });

    panel.querySelector('#hm-toggle').onclick = () => {
      panel.classList.toggle('hm-collapsed');
    };

    panel.querySelector('#hm-recall').onclick = async () => {
      try {
        const query = getUserPrompt();
        const prepared = await api('/api/integrations/webapp/prepare', {
          platform: detectPlatform(),
          query,
          user_prompt: query,
          project: projectInput.value.trim() || null,
          preferred_source_platforms: [detectPlatform()],
          preferred_tags: splitCsv(tagsInput.value),
          max_memories: 5
        });
        insertAtCursor(prepared.context.injection_text);
        output.textContent = JSON.stringify({
          ok: true,
          search_method: prepared.search_method,
          memories: prepared.context.memories.length
        }, null, 2);
      } catch (error) {
        output.textContent = `Recall failed: ${error.message}`;
      }
    };

    panel.querySelector('#hm-save').onclick = async () => {
      try {
        const content = getLastAssistantMessage();
        const query = getUserPrompt();
        const saved = await api('/api/integrations/webapp/store', {
          platform: detectPlatform(),
          content,
          memory_type: 'lesson',
          title: `${detectPlatform()} captured answer`,
          tags: ['webapp-capture', detectPlatform()],
          importance_score: 0.7,
          project: projectInput.value.trim() || null,
          metadata: {
            source_page: location.href,
            prompt_excerpt: query.slice(0, 240)
          }
        });
        output.textContent = JSON.stringify({
          success: true,
          memory_id: saved.memory.id,
          source: saved.memory.source
        }, null, 2);
      } catch (error) {
        output.textContent = `Save failed: ${error.message}`;
      }
    };
  }

  function init() {
    if (document.getElementById('hivemind-web-bridge')) return;
    createPanel();
  }

  window.addEventListener('load', () => setTimeout(init, 1200));
})();
