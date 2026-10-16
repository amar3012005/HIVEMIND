import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { executeOwnedBrowserOperation } from '../src/desktop-browser-page.mjs';
const require = createRequire(import.meta.url);
const { createElectronBrowserPage } = require('../src/electron-browser-page');
const { chromium } = require('playwright');
let browser;
before(async () => { browser = await chromium.launch({ headless: true, chromiumSandbox: true }); });
after(async () => { await browser?.close(); });
async function fixture(signal) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.route('https://fixture.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<label>Name<input id="name" aria-label="Name"></label><textarea placeholder="Notes"></textarea><button id="continue" onclick="document.body.dataset.clicks=\'1\'">Continue</button>' }));
  await page.goto('https://fixture.invalid/native');
  const protocol = await context.newCDPSession(page);
  await protocol.send('DOM.enable'); await protocol.send('Accessibility.enable');
  const contents = { debugger: { sendCommand: (method, parameters) => protocol.send(method, parameters) },
    isDestroyed: () => page.isClosed(), getURL: () => page.url(), getTitle: () => 'Native fixture', loadURL: url => page.goto(url), stop: () => {} };
  return { context, page, native: createElectronBrowserPage(contents, signal, { interrupt: () => { void page.close(); } }) };
}

test('native CDP adapter pins accessible controls and updates exact fields without exposing values', async () => {
  const f = await fixture(); const grants = [];
  try {
    await executeOwnedBrowserOperation(f.native, { kind: 'browser.clickText', text: 'Continue' }, async action => { grants.push(action); return true; });
    assert.equal(await f.page.evaluate(() => document.body.dataset.clicks), '1');
    const result = await executeOwnedBrowserOperation(f.native, { kind: 'browser.typeText', field: 'Name', text: 'private-value', submit: false }, async () => true);
    assert.equal(await f.page.locator('#name').inputValue(), 'private-value');
    assert.doesNotMatch(JSON.stringify(result), /private-value/);
    await executeOwnedBrowserOperation(f.native, { kind: 'browser.typeText', field: 'Notes', text: 'placeholder-value', submit: false }, async () => true);
    assert.equal(await f.page.getByPlaceholder('Notes').inputValue(), 'placeholder-value');
    assert.deepEqual(grants, ['click']);
  } finally { await f.context.close(); }
});
test('native adapter rejects detached targets and overlay click recipients after consent', async () => {
  for (const overlay of [true, false]) {
    const f = await fixture();
    try {
      await assert.rejects(executeOwnedBrowserOperation(f.native, { kind: 'browser.clickText', text: 'Continue' }, async () => {
        await f.page.evaluate(useOverlay => {
          if (useOverlay) {
            const target = document.createElement('button'); target.textContent = 'Other'; target.style.cssText = 'position:fixed;inset:0;z-index:99999';
            target.onclick = () => { document.body.dataset.other = '1'; }; document.body.append(target);
          } else { const target = document.querySelector('#continue'); target.replaceWith(target.cloneNode(true)); }
        }, overlay);
        return true;
      }), /changed|actionable|unknown/);
      assert.equal(await f.page.evaluate(() => document.body.dataset.clicks || '0'), '0');
      assert.equal(await f.page.evaluate(() => document.body.dataset.other || '0'), '0');
    } finally { await f.context.close(); }
  }
});
test('native adapter checks field classification and request cancellation at the protocol boundary', async () => {
  const controller = new AbortController(); const f = await fixture(controller.signal);
  try {
    await assert.rejects(executeOwnedBrowserOperation(f.native, { kind: 'browser.typeText', field: 'Name', text: 'must-not-write', submit: false }, async () => {
      await f.page.locator('#name').evaluate(element => { element.type = 'password'; }); return true;
    }), /changed|manual control/);
    assert.equal(await f.page.locator('#name').inputValue(), '');
    await f.page.locator('#name').evaluate(element => { element.type = 'text'; });
    await assert.rejects(executeOwnedBrowserOperation(f.native, { kind: 'browser.typeText', field: 'Name', text: 'must-not-write', submit: false }, async () => {
      controller.abort(new Error('cancelled native operation')); return true;
    }, { signal: controller.signal }), /cancelled/);
    assert.equal(await f.page.locator('#name').inputValue(), '');
  } finally { await f.context.close(); }
});
test('cancelling in-flight page JavaScript interrupts it before a delayed approved click', async () => {
  const controller = new AbortController(); const f = await fixture(controller.signal);
  try {
    await f.page.locator('#continue').evaluate(element => {
      const bounds = element.getBoundingClientRect.bind(element); let calls = 0;
      element.getBoundingClientRect = () => {
        if (++calls === 2) {
          console.log('singulance-qa-cdp-stalled');
          const end = performance.now() + 3000; while (performance.now() < end) {}
        }
        return bounds();
      };
    });
    f.page.on('console', message => { if (message.text() === 'singulance-qa-cdp-stalled') controller.abort(new Error('cancelled in-flight native action')); });
    await assert.rejects(executeOwnedBrowserOperation(f.native, { kind: 'browser.clickText', text: 'Continue' }, async () => true,
      { signal: controller.signal }), /cancelled|unknown/);
    if (!f.page.isClosed()) assert.equal(await f.page.evaluate(() => document.body.dataset.clicks || '0'), '0');
  } finally { await f.context.close(); }
});
test('native browser captures only the fixed page viewport and supports consented keyboard submission', async () => {
  const f = await fixture(); const grants = [];
  try {
    await f.page.setContent('<form onsubmit="event.preventDefault();document.body.dataset.submitted=\'1\'"><label>Name<input id="name" aria-label="Name"></label><button>Send</button></form>');
    await executeOwnedBrowserOperation(f.native, { kind: 'browser.typeText', field: 'Name', text: 'fixture', submit: true }, async action => { grants.push(action); return true; });
    assert.equal(await f.page.evaluate(() => document.body.dataset.submitted), '1');
    assert.deepEqual(grants, ['fill', 'press']);
    const result = await executeOwnedBrowserOperation(f.native, { kind: 'browser.screenshot' }, async () => true);
    const image = Buffer.from(result.content[0].data, 'base64');
    assert.equal(image.readUInt32BE(16), 1280); assert.equal(image.readUInt32BE(20), 800);
  } finally { await f.context.close(); }
});
