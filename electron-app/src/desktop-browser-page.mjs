const ROLES = ['button', 'link', 'checkbox', 'menuitem', 'radio', 'tab', 'option'];
const NAVIGATION_KEYS = new Set(['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown']);
const KEY_NAMES = { ENTER: 'Enter', RETURN: 'Enter', ESC: 'Escape', ESCAPE: 'Escape', TAB: 'Tab', SPACE: 'Space', BACKSPACE: 'Backspace', DELETE: 'Delete', HOME: 'Home', END: 'End', PAGEUP: 'PageUp', PAGEDOWN: 'PageDown', UP: 'ArrowUp', DOWN: 'ArrowDown', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight', ARROWUP: 'ArrowUp', ARROWDOWN: 'ArrowDown', ARROWLEFT: 'ArrowLeft', ARROWRIGHT: 'ArrowRight', CTRL: 'Control', CONTROL: 'Control', CMD: 'Meta', COMMAND: 'Meta', META: 'Meta', SHIFT: 'Shift' };
const text = (value, max) => {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('Invalid browser text');
  return value;
};
const point = value => {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y) || value.x < 0 || value.x > 1280 || value.y < 0 || value.y > 800) throw new Error('Browser point is outside its viewport');
  return value;
};
async function attempted(operation, name) {
  try { return await operation(); }
  catch {
    const error = new Error(`Local browser ${name} outcome is unknown; inspect before repeating`);
    error.desktopOutcomeUnknown = true;
    throw error;
  }
}
async function pinned(locator, operation) {
  if (await locator.count() !== 1) throw new Error('Browser target is missing or ambiguous');
  const handle = await locator.elementHandle({ timeout: 1000 });
  if (!handle) throw new Error('Browser target is unavailable');
  try { return await operation(handle); }
  finally { await handle.dispose(); }
}
async function fieldOnly(handle, focused = false) {
  if (!await handle.evaluate((element, needFocus) => {
    const tag = element.tagName.toLowerCase();
    return element.isConnected && (!needFocus || element.ownerDocument.activeElement === element) &&
      (tag === 'textarea' || element.isContentEditable || tag === 'input' && !['password', 'file', 'hidden'].includes(element.type));
  }, focused)) throw new Error('Browser field changed or requires manual control on the Mac');
}
async function actionable(handle) {
  if (!await handle.evaluate(element => element.isConnected) || !await handle.isVisible() || !await handle.isEnabled()) throw new Error('Browser target changed or is not actionable');
}

export async function executeOwnedBrowserOperation(page, operation, approve, { signal, authorize = async () => true } = {}) {
  if (!operation || typeof operation !== 'object') throw new Error('Invalid browser operation');
  signal?.throwIfAborted();
  if (operation.kind !== 'browser.openUrl' && page.url() !== 'about:blank' && !/^https?:\/\//.test(page.url())) throw new Error('Only web pages may be inspected or controlled through this connection');
  const current = async () => {
    signal?.throwIfAborted();
    if (!await authorize()) throw new Error('Browser execution authority revoked; do not retry this action');
    signal?.throwIfAborted();
  };
  const allow = async (action, target) => {
    const url = page.url();
    signal?.throwIfAborted();
    if (!await approve(action, target) || page.isClosed() || page.url() !== url) throw new Error('Browser access denied, expired or page changed; do not retry this action');
    await current();
  };
  await current();
  switch (operation.kind) {
    case 'browser.openUrl': {
      const url = new URL(text(operation.url, 4096));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only credential-free HTTP(S) pages are supported');
      await current();
      await attempted(() => page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 }), 'navigation');
      return { content: [{ type: 'text', text: `Opened ${url.origin}.` }] };
    }
    case 'browser.readPage': {
      let body; let title;
      try { body = await page.locator('body').innerText({ timeout: 8000 }); title = await page.title(); }
      catch { throw new Error('Browser page text is unavailable'); }
      signal?.throwIfAborted();
      return { content: [{ type: 'text', text: `${title.slice(0, 240)}\n\n${body.slice(0, 20000)}${body.length > 20000 ? '\n[Page text truncated]' : ''}` }] };
    }
    case 'browser.screenshot': {
      let image;
      try { image = await page.screenshot({ type: 'png', fullPage: false, timeout: 15000 }); }
      catch { throw new Error('Browser screenshot is unavailable'); }
      signal?.throwIfAborted();
      if (image.length > 8 * 1024 * 1024) throw new Error('Browser screenshot exceeds its limit');
      return { content: [{ type: 'image', mimeType: 'image/png', data: image.toString('base64') }] };
    }
    case 'browser.clickText': {
      const name = text(operation.text, 160);
      let target; let count = 0;
      for (const role of ROLES) {
        const locator = page.getByRole(role, { name, exact: true });
        const matches = await locator.count(); count += matches;
        if (matches === 1) target = locator;
      }
      if (count !== 1 || !target) throw new Error('Browser control is missing or ambiguous; inspect the current page');
      await pinned(target, async handle => {
        await allow('click', `Control: ${name}`);
        await actionable(handle); await current();
        await attempted(() => handle.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          const hit = element.ownerDocument.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
          if (!element.isConnected || !hit || !element.contains(hit)) throw new Error('Browser target changed');
          element.click();
        }), 'click');
      });
      return { content: [{ type: 'text', text: 'Clicked the approved browser control.' }] };
    }
    case 'browser.typeText': {
      const field = text(operation.field, 160); const value = text(operation.text, 4096);
      if (typeof operation.submit !== 'boolean') throw new Error('Invalid browser submit flag');
      let target = page.getByLabel(field, { exact: true });
      if (await target.count() === 0) target = page.getByPlaceholder(field, { exact: true });
      await pinned(target, async handle => {
        await fieldOnly(handle);
        await allow('fill', `Field: ${field}`);
        await actionable(handle); await current(); await fieldOnly(handle); signal?.throwIfAborted();
        await attempted(() => handle.fill(value, { force: true, timeout: 1000 }), 'field update');
        if (operation.submit) {
          await allow('press', 'Key: Enter'); await fieldOnly(handle); signal?.throwIfAborted();
          await attempted(() => handle.press('Enter', { timeout: 1000, noWaitAfter: true }), 'submission');
        }
      });
      return { content: [{ type: 'text', text: 'Updated the approved browser field; its value was not returned.' }] };
    }
    case 'browser.doAction': {
      const action = operation.action;
      if (!action || typeof action !== 'object') throw new Error('Invalid browser action');
      switch (action.type) {
        case 'screenshot': return executeOwnedBrowserOperation(page, { kind: 'browser.screenshot' }, approve, { signal, authorize });
        case 'move': { const p = point(action); await current(); await page.mouse.move(p.x, p.y); break; }
        case 'scroll': {
          const p = point(action);
          if (!Number.isFinite(action.scroll_x) || !Number.isFinite(action.scroll_y) || Math.abs(action.scroll_x) > 10000 || Math.abs(action.scroll_y) > 10000) throw new Error('Invalid browser scroll');
          await current(); await page.mouse.move(p.x, p.y); signal?.throwIfAborted(); await page.mouse.wheel(action.scroll_x, action.scroll_y); break;
        }
        case 'click': case 'double_click': {
          const p = point(action); const button = action.button || 'left';
          if (!['left', 'right', 'wheel', 'back', 'forward'].includes(button) || action.keys?.length) throw new Error('Unsupported browser click');
          await allow('click', `${action.type}: ${p.x}, ${p.y}`);
          await attempted(async () => {
            signal?.throwIfAborted();
            if (button === 'back') await page.goBack({ timeout: 1000 });
            else if (button === 'forward') await page.goForward({ timeout: 1000 });
            else if (action.type === 'double_click') await page.mouse.dblclick(p.x, p.y);
            else await page.mouse.click(p.x, p.y, { button: button === 'wheel' ? 'middle' : button });
          }, 'click'); break;
        }
        case 'type': {
          const value = text(action.text, 4096);
          await pinned(page.locator(':focus'), async handle => {
            await fieldOnly(handle, true);
            await allow('fill', 'Focused browser field');
            await actionable(handle); await current(); await fieldOnly(handle, true); signal?.throwIfAborted();
            await attempted(() => handle.fill(value, { force: true, timeout: 1000 }), 'field update');
          }); break;
        }
        case 'keypress': {
          if (!Array.isArray(action.keys) || !action.keys.length || action.keys.length > 2) throw new Error('Invalid browser keys');
          const parts = action.keys.map(value => { const raw = text(value, 64); return KEY_NAMES[raw.toUpperCase()] || raw; });
          const chord = parts.join('+');
          const selectAll = parts.length === 2 && ['Control', 'Meta'].includes(parts[0]) && parts[1].toUpperCase() === 'A';
          if (!(parts.length === 1 && NAVIGATION_KEYS.has(parts[0])) && chord !== 'Shift+Tab' && !selectAll) throw new Error('Browser toolbar, clipboard and system shortcuts are not granted');
          const focus = page.locator(':focus');
          const target = selectAll || await focus.count() === 1 ? focus : page.locator('body');
          await pinned(target, async handle => {
            if (selectAll) await fieldOnly(handle, true);
            await allow('press', `Keys: ${chord}`); await current();
            if (selectAll) await fieldOnly(handle, true);
            signal?.throwIfAborted();
            await attempted(() => handle.press(chord, { timeout: 1000, noWaitAfter: true }), 'key press');
          }); break;
        }
        case 'drag': {
          if (!Array.isArray(action.path) || action.path.length < 2 || action.path.length > 100) throw new Error('Invalid browser drag');
          const points = action.path.map(point);
          await allow('click', 'Drag within the managed browser');
          await attempted(async () => {
            signal?.throwIfAborted(); await page.mouse.move(points[0].x, points[0].y); signal?.throwIfAborted(); await page.mouse.down();
            try { for (const p of points.slice(1)) { signal?.throwIfAborted(); await page.mouse.move(p.x, p.y); } }
            finally { await page.mouse.up(); }
          }, 'drag'); break;
        }
        case 'wait': break;
        default: throw new Error('Browser action is not supported');
      }
      return { content: [{ type: 'text', text: 'Completed the scoped browser action.' }] };
    }
    default: throw new Error('Browser operation is not supported');
  }
}
