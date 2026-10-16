const KEY_CODES = { Enter: 13, Escape: 27, Tab: 9, ' ': 32, Backspace: 8, Delete: 46,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'checkbox', 'radio']);

function createElectronBrowserPage(contents, signal, { interrupt }) {
  if (typeof interrupt !== 'function') throw new Error('A managed-window interruption handler is required');
  const check = () => {
    signal?.throwIfAborted();
    if (contents.isDestroyed()) throw new Error('Managed browser window is closed');
  };
  const send = (method, parameters = {}) => {
    check();
    return new Promise((resolve, reject) => {
      let finished = false; let stopping = false; let stopTimer;
      const finish = (error, result) => {
        if (finished) return;
        finished = true; clearTimeout(timer); clearTimeout(stopTimer);
        signal?.removeEventListener('abort', aborted);
        error ? reject(error) : resolve(result);
      };
      const stop = reason => {
        if (finished || stopping) return;
        stopping = true;
        const close = () => { try { interrupt(); } finally { finish(reason); } };
        stopTimer = setTimeout(close, 1000);
        Promise.resolve().then(() => contents.debugger.sendCommand('Runtime.terminateExecution'))
          .then(() => contents.debugger.sendCommand('Runtime.evaluate', { expression: '0', returnByValue: true, silent: true }))
          .then(() => finish(reason), close);
      };
      const aborted = () => stop(signal.reason || new Error('Managed browser request cancelled'));
      const timer = setTimeout(() => stop(new Error(`Managed browser ${method} command deadline elapsed`)), 15000);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) { aborted(); return; }
      Promise.resolve().then(() => {
        if (stopping) return;
        return contents.debugger.sendCommand(method, parameters);
      }).then(result => {
        if (stopping) return;
        try { check(); finish(null, result); } catch (error) { finish(error); }
      }, error => { if (!stopping) finish(error); });
    });
  };
  const release = async objectId => {
    if (!objectId || contents.isDestroyed()) return;
    let timer;
    try { await Promise.race([contents.debugger.sendCommand('Runtime.releaseObject', { objectId }).catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); }
    finally { clearTimeout(timer); }
  };
  async function handle(reference) {
    const objectId = reference.objectId || (await send('DOM.resolveNode', reference)).object.objectId;
    if (!objectId) throw new Error('Browser target is unavailable');
    const evaluate = async (operation, argument) => {
      const response = await send('Runtime.callFunctionOn', { objectId,
        functionDeclaration: `function(argument) { return (${operation.toString()})(this, argument); }`,
        arguments: argument === undefined ? [] : [{ value: argument }], returnByValue: true, awaitPromise: false });
      if (response.exceptionDetails) throw new Error('Browser target changed or rejected the operation');
      return response.result.value;
    };
    return {
      evaluate,
      dispose: () => release(objectId),
      isVisible: () => evaluate(element => {
        const bounds = element.getBoundingClientRect(); const style = getComputedStyle(element);
        return element.isConnected && bounds.width > 0 && bounds.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      }),
      isEnabled: () => evaluate(element => !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true'),
      async fill(value) {
        const updated = await evaluate((element, text) => {
          const tag = element.tagName.toLowerCase();
          if (!element.isConnected || element.disabled || element.readOnly || tag === 'input' && ['password', 'file', 'hidden'].includes(element.type)) throw new Error('Field is not editable');
          if (tag === 'input' || tag === 'textarea') {
            const prototype = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
            Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, text);
          } else if (element.isContentEditable) element.textContent = text;
          else throw new Error('Field is not editable');
          element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: text }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          return element.isConnected && (tag === 'input' || tag === 'textarea' ? element.value : element.textContent) === text;
        }, value);
        if (!updated) throw new Error('Browser field did not accept the approved text');
      },
      async press(chord) {
        await evaluate(element => {
          if (!element.isConnected) throw new Error('Target is detached');
          element.focus();
        });
        const parts = chord.split('+');
        const key = parts.at(-1) === 'Space' ? ' ' : parts.at(-1);
        const modifiers = parts.slice(0, -1).reduce((value, part) => value | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[part] || 0), 0);
        const parameters = { key, code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key,
          windowsVirtualKeyCode: KEY_CODES[key] || key.toUpperCase().charCodeAt(0), modifiers,
          ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : key === ' ' ? { text: ' ', unmodifiedText: ' ' } : {}),
          ...(key.toUpperCase() === 'A' && modifiers & 6 ? { commands: ['selectAll'] } : {}) };
        await send('Input.dispatchKeyEvent', { type: 'keyDown', ...parameters });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...parameters, text: '', unmodifiedText: '' });
      },
    };
  }
  function locator(query) {
    return {
      async count() {
        const references = await query();
        for (const reference of references) await release(reference.objectId);
        return references.length;
      },
      async elementHandle() {
        const references = await query();
        if (references.length !== 1) {
          for (const reference of references) await release(reference.objectId);
          throw new Error('Browser target is missing or ambiguous');
        }
        return handle(references[0]);
      },
      async innerText() {
        const target = await this.elementHandle();
        try { return await target.evaluate(element => (element.innerText || '').slice(0, 24000)); }
        finally { await target.dispose(); }
      },
    };
  }
  async function accessible(name, role) {
    const document = await send('DOM.getDocument', { depth: 0 });
    const tree = await send('Accessibility.queryAXTree', { nodeId: document.root.nodeId, accessibleName: name, ...(role ? { role } : {}) });
    const matches = tree.nodes.filter(node => !node.ignored && node.name?.value === name && node.backendDOMNodeId && (role || FIELD_ROLES.has(node.role?.value)));
    if (matches.length > 64) throw new Error('Browser target query is too broad');
    return matches.map(node => ({ backendNodeId: node.backendDOMNodeId }));
  }
  async function placeholder(name) {
    const response = await send('Runtime.evaluate', { expression: `Array.from(document.querySelectorAll('input[placeholder],textarea[placeholder]')).filter(element => element.getAttribute('placeholder') === ${JSON.stringify(name)}).slice(0,65)`, returnByValue: false });
    if (response.exceptionDetails || !response.result.objectId) throw new Error('Browser field query is unavailable');
    const array = response.result.objectId;
    try {
      const properties = await send('Runtime.getProperties', { objectId: array, ownProperties: true });
      const references = properties.result.filter(property => /^\d+$/.test(property.name) && property.value?.objectId).map(property => ({ objectId: property.value.objectId }));
      if (references.length > 64) {
        for (const reference of references) await release(reference.objectId);
        throw new Error('Browser field query is too broad');
      }
      return references;
    } finally { await release(array); }
  }
  let mouse = { x: 0, y: 0 };
  const move = async (x, y) => { mouse = { x, y }; await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); };
  const button = async (type, name = 'left', clickCount = 1) => send('Input.dispatchMouseEvent', {
    type, ...mouse, button: name, buttons: type === 'mousePressed' ? ({ left: 1, right: 2, middle: 4 }[name] || 0) : 0, clickCount,
  });
  return {
    async initialize() {
      for (const method of ['Page.enable', 'DOM.enable', 'Accessibility.enable']) await send(method);
      await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    },
    url: () => contents.getURL(),
    isClosed: () => contents.isDestroyed(),
    title: () => contents.getTitle(),
    async goto(url) {
      check();
      let timer; let cancel;
      try {
        await Promise.race([contents.loadURL(url), new Promise((_, reject) => {
          cancel = () => { contents.stop(); reject(signal.reason || new Error('Browser navigation cancelled')); };
          signal?.addEventListener('abort', cancel, { once: true });
          timer = setTimeout(() => { contents.stop(); reject(new Error('Browser navigation timed out')); }, 30000);
        })]);
        check();
      } finally { clearTimeout(timer); if (cancel) signal?.removeEventListener('abort', cancel); }
    },
    async goBack() { check(); contents.navigationHistory.goBack(); },
    async goForward() { check(); contents.navigationHistory.goForward(); },
    async screenshot() { return Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'); },
    getByRole: (role, options) => locator(() => accessible(options.name, role)),
    getByLabel: name => locator(() => accessible(name)),
    getByPlaceholder: name => locator(() => placeholder(name)),
    locator(selector) {
      if (!['body', ':focus'].includes(selector)) throw new Error('Unsupported internal browser selector');
      return locator(async () => {
        const document = await send('DOM.getDocument', { depth: 0 });
        return (await send('DOM.querySelectorAll', { nodeId: document.root.nodeId, selector })).nodeIds.map(nodeId => ({ nodeId }));
      });
    },
    mouse: {
      move,
      wheel: (deltaX, deltaY) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...mouse, deltaX, deltaY }),
      down: () => button('mousePressed'), up: () => button('mouseReleased'),
      async click(x, y, options = {}) { await move(x, y); await button('mousePressed', options.button); await button('mouseReleased', options.button); },
      async dblclick(x, y) { await move(x, y); for (const count of [1, 2]) { await button('mousePressed', 'left', count); await button('mouseReleased', 'left', count); } },
    },
  };
}
module.exports = { createElectronBrowserPage };
