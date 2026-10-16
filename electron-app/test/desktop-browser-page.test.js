const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/desktop-browser-page.mjs');
function fixture() {
  const calls = [];
  let url = 'https://example.com/fixture';
  let editable = true;
  const element = { tagName: 'INPUT', type: 'text', isContentEditable: false, isConnected: true, ownerDocument: {} };
  element.ownerDocument.activeElement = element;
  element.ownerDocument.elementFromPoint = () => element;
  element.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 30 });
  element.contains = other => other === element;
  element.click = () => { calls.push(['click']); };
  const field = {
    count: async () => 1,
    elementHandle: async () => field,
    dispose: async () => {},
    isVisible: async () => true,
    isEnabled: async () => true,
    evaluate: async (fn, arg) => { element.type = editable ? 'text' : 'password'; return fn(element, arg); },
    fill: async value => { calls.push(['fill', value]); },
    press: async value => { calls.push(['press', value]); },
    click: async () => { calls.push(['click']); },
    innerText: async () => 'Fixture content',
  };
  const missing = { count: async () => 0 };
  const page = {
    url: () => url, isClosed: () => false,
    goto: async value => { url = value; calls.push(['navigate']); },
    title: async () => 'Fixture',
    locator: () => field, getByLabel: () => field, getByPlaceholder: () => field,
    getByRole: role => role === 'button' ? field : missing,
    screenshot: async () => Buffer.from('fixture-image'),
    mouse: { click: async () => { calls.push(['mouse']); }, move: async () => {}, wheel: async () => {}, down: async () => {}, up: async () => {} },
  };
  return { page, calls, field, element, setUrl: value => { url = value; }, password: () => { editable = false; } };
}

test('owned browser navigation rejects local files and embedded credentials', async () => {
  const { executeOwnedBrowserOperation: execute } = await load();
  for (const url of ['file:///private/example', 'javascript:void(0)', 'https://user:secret@example.com']) {
    const f = fixture();
    await assert.rejects(execute(f.page, { kind: 'browser.openUrl', url }, async () => true), /HTTP/);
    assert.equal(f.calls.length, 0);
  }
});

test('click denial and page changes prevent browser mutation', async () => {
  const { executeOwnedBrowserOperation: execute } = await load();
  const f = fixture();
  await assert.rejects(execute(f.page, { kind: 'browser.clickText', text: 'Continue' }, async () => false), /denied/);
  await assert.rejects(execute(f.page, { kind: 'browser.clickText', text: 'Continue' }, async () => { f.setUrl('https://example.com/changed'); return true; }), /changed/);
  assert.equal(f.calls.length, 0);
});

test('field values are not returned and submission has a separate approval', async () => {
  const { executeOwnedBrowserOperation: execute } = await load();
  const f = fixture(); const approvals = [];
  const output = await execute(f.page, { kind: 'browser.typeText', field: 'Name', text: 'private-fixture-value', submit: true }, async action => { approvals.push(action); return true; });
  assert.deepEqual(approvals, ['fill', 'press']);
  assert.deepEqual(f.calls, [['fill', 'private-fixture-value'], ['press', 'Enter']]);
  assert.doesNotMatch(JSON.stringify(output), /private-fixture-value/);
});

test('password fields and browser/system shortcuts are not granted', async () => {
  const { executeOwnedBrowserOperation: execute } = await load();
  const f = fixture(); f.password();
  await assert.rejects(execute(f.page, { kind: 'browser.typeText', field: 'Password', text: 'fixture', submit: false }, async () => true), /manual control/);
  await assert.rejects(execute(f.page, { kind: 'browser.doAction', action: { type: 'keypress', keys: ['META', 'L'] } }, async () => true), /shortcuts/);
  await assert.rejects(execute(f.page, { kind: 'browser.doAction', action: { type: 'click', x: -1, y: 10 } }, async () => true), /viewport/);
  assert.equal(f.calls.length, 0);
});

test('failed attempted clicks have an unknown outcome and no raw error leak', async () => {
  const { executeOwnedBrowserOperation: execute } = await load();
  const f = fixture();
  f.element.click = () => { throw new Error('private-provider-detail'); };
  await assert.rejects(execute(f.page, { kind: 'browser.clickText', text: 'Continue' }, async () => true), error => {
    assert.equal(error.desktopOutcomeUnknown, true);
    assert.doesNotMatch(error.message, /private-provider-detail/);
    return true;
  });
});

test('field type and focused target are rechecked after native approval', async () => {
  const { executeOwnedBrowserOperation: execute } = await load();
  const typed = fixture();
  await assert.rejects(execute(typed.page, { kind: 'browser.typeText', field: 'Name', text: 'fixture', submit: false }, async () => { typed.password(); return true; }), /field changed|manual control/);
  assert.equal(typed.calls.length, 0);
  const focused = fixture();
  await assert.rejects(execute(focused.page, { kind: 'browser.doAction', action: { type: 'type', text: 'fixture' } }, async () => {
    focused.element.ownerDocument.activeElement = {};
    return true;
  }), /field changed|manual control/);
  assert.equal(focused.calls.length, 0);
});

test('cancelled or revoked execution cannot mutate after native approval', async () => {
  const { executeOwnedBrowserOperation: execute } = await load();
  const f = fixture(); const controller = new AbortController();
  await assert.rejects(execute(f.page, { kind: 'browser.clickText', text: 'Continue' }, async () => {
    controller.abort(new Error('cancelled'));
    return true;
  }, { signal: controller.signal }), /cancelled/);
  assert.equal(f.calls.length, 0);
  let checks = 0;
  await assert.rejects(execute(f.page, { kind: 'browser.clickText', text: 'Continue' }, async () => true, {
    authorize: async () => ++checks === 1,
  }), /authority revoked/);
  assert.equal(f.calls.length, 0);
});

test('approved clicks do not retain deferred actionability waits', async () => {
  const { executeOwnedBrowserOperation: execute } = await load();
  const f = fixture();
  f.field.click = async () => { throw new Error('Deferred pointer dispatch must not be used for a semantic control'); };
  await execute(f.page, { kind: 'browser.clickText', text: 'Continue' }, async () => true);
  assert.deepEqual(f.calls, [['click']]);
});

test('screenshots remain browser-only and non-web pages cannot be inspected', async () => {
  const { executeOwnedBrowserOperation: execute } = await load();
  const f = fixture();
  const output = await execute(f.page, { kind: 'browser.screenshot' }, async () => true);
  assert.equal(output.content[0].type, 'image');
  assert.equal(output.content[0].mimeType, 'image/png');
  f.setUrl('file:///private/example');
  await assert.rejects(execute(f.page, { kind: 'browser.readPage' }, async () => true), /Only web pages/);
});
