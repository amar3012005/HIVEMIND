import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { executeOwnedBrowserOperation } from '../src/desktop-browser-page.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
let browser;
before(async () => { browser = await chromium.launch({ headless: true, chromiumSandbox: true }); });
after(async () => { await browser?.close(); });
async function fixture() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route('https://fixture.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<label>Name<input id="name" aria-label="Name"></label><button id="continue" onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1)">Continue</button>' }));
  await page.goto('https://fixture.invalid/owned');
  return page;
}

test('real pinned click target replacement during consent never reaches the replacement', async () => {
  const page = await fixture();
  try {
    await assert.rejects(executeOwnedBrowserOperation(page, { kind: 'browser.clickText', text: 'Continue' }, async () => {
      await page.evaluate(() => { const old = document.querySelector('#continue'); old.replaceWith(old.cloneNode(true)); });
      return true;
    }), /changed|not actionable/);
    assert.equal(await page.evaluate(() => document.body.dataset.clicks || '0'), '0');
  } finally { await page.close(); }
});
test('an overlay inserted during consent cannot receive the approved semantic click', async () => {
  const page = await fixture();
  try {
    await assert.rejects(executeOwnedBrowserOperation(page, { kind: 'browser.clickText', text: 'Continue' }, async () => {
      await page.evaluate(() => {
        const overlay = document.createElement('button'); overlay.textContent = 'Different action';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:999999';
        overlay.onclick = () => { document.body.dataset.overlayClicks = '1'; };
        document.body.append(overlay);
      });
      return true;
    }), /target changed|outcome is unknown/);
    assert.equal(await page.evaluate(() => document.body.dataset.overlayClicks || '0'), '0');
    assert.equal(await page.evaluate(() => document.body.dataset.clicks || '0'), '0');
  } finally { await page.close(); }
});
test('real field replacement and password reclassification after consent cannot receive text', async () => {
  for (const replacement of [true, false]) {
    const page = await fixture();
    try {
      await assert.rejects(executeOwnedBrowserOperation(page, { kind: 'browser.typeText', field: 'Name', text: 'private-value', submit: false }, async () => {
        await page.evaluate(replace => { const field = document.querySelector('#name'); if (replace) field.replaceWith(field.cloneNode(true)); else field.type = 'password'; }, replacement);
        return true;
      }), /field changed|manual control|not actionable/);
      assert.equal(await page.locator('#name').inputValue(), '');
    } finally { await page.close(); }
  }
});
test('real focused-field changes during approval are rejected', async () => {
  const page = await fixture();
  try {
    await page.locator('#name').focus();
    await assert.rejects(executeOwnedBrowserOperation(page, { kind: 'browser.doAction', action: { type: 'type', text: 'private-value' } }, async () => {
      await page.locator('#continue').focus(); return true;
    }), /field changed|manual control/);
    assert.equal(await page.locator('#name').inputValue(), '');
  } finally { await page.close(); }
});
test('cancellation while consent is open and lease loss immediately after consent prevent mutation', async () => {
  for (const abort of [true, false]) {
    const page = await fixture(); const controller = new AbortController(); let authorized = true;
    let entered; const waiting = new Promise(resolve => { entered = resolve; });
    let release; const consent = new Promise(resolve => { release = resolve; });
    try {
      const operation = executeOwnedBrowserOperation(page, { kind: 'browser.clickText', text: 'Continue' }, async () => { entered(); return consent; }, {
        signal: controller.signal, authorize: async () => authorized,
      });
      const rejected = assert.rejects(operation, /cancelled|authority revoked/);
      await waiting;
      if (abort) controller.abort(new Error('cancelled')); else authorized = false;
      release(true); await rejected;
      assert.equal(await page.evaluate(() => document.body.dataset.clicks || '0'), '0');
    } finally { await page.close(); }
  }
});
test('real page navigation during native approval prevents a stale-page action', async () => {
  const page = await fixture();
  try {
    await assert.rejects(executeOwnedBrowserOperation(page, { kind: 'browser.clickText', text: 'Continue' }, async () => {
      await page.goto('https://fixture.invalid/replaced'); return true;
    }), /page changed/);
    assert.equal(await page.evaluate(() => document.body.dataset.clicks || '0'), '0');
  } finally { await page.close(); }
});
test('real approved field submission requests two grants and returns no field value', async () => {
  const page = await fixture(); const grants = [];
  try {
    const result = await executeOwnedBrowserOperation(page, { kind: 'browser.typeText', field: 'Name', text: 'private-value', submit: true }, async action => { grants.push(action); return true; });
    assert.deepEqual(grants, ['fill', 'press']);
    assert.equal(await page.locator('#name').inputValue(), 'private-value');
    assert.doesNotMatch(JSON.stringify(result), /private-value/);
  } finally { await page.close(); }
});
