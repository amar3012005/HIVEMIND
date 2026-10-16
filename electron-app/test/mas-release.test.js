const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const identifier = /^[A-Za-z_$][\w$]*$/;
const runtimeInstaller = /\b(?:(?:download|install|ensure)[\w./\\-]*(?:browser|runtime)|(?:browser|runtime)[\w./\\-]*(?:download|install))\b|(?:agent[-_]browser[-_]runtime|managed-agent-browser|runtime-installer)/i;

// Load only the static builder configuration. Inspect Electron entry points as
// source, without starting the app, invoking hooks, or loading its browser runtime.
function source(relative) {
  const lexical = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\r\n])+\/[a-z]*|[A-Za-z_$][\w$]*|===|!==|==|!=|=>|&&|\|\||\?\?|\?\.|[^\s]/g;
  const tokens = [...read(relative).matchAll(lexical)]
    .map(match => match[0])
    .filter(token => !token.startsWith('//') && !token.startsWith('/*'));
  const closing = { '(': ')', '[': ']', '{': '}' };
  const pairs = new Map();
  const stack = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (Object.hasOwn(closing, tokens[i])) stack.push(i);
    else if ([')', ']', '}'].includes(tokens[i])) {
      const opening = stack.pop();
      assert.equal(closing[tokens[opening]], tokens[i], `${relative}: balanced source delimiters`);
      pairs.set(opening, i);
      pairs.set(i, opening);
    }
  }
  assert.equal(stack.length, 0, `${relative}: balanced source delimiters`);
  return { tokens, pairs };
}

function masPredicate(tokens) {
  const condition = tokens.filter(token => token !== '(' && token !== ')').join('')
    .replace(/process\[['"]mas['"]\]/g, 'process.mas');
  if (['process.mas', '!!process.mas', 'Booleanprocess.mas', 'process.mas===true', 'process.mas==true', 'process.mas!==false', 'process.mas!=false'].includes(condition)) return true;
  if (['!process.mas', '!Booleanprocess.mas', 'process.mas===false', 'process.mas==false', 'process.mas!==true', 'process.mas!=true'].includes(condition)) return false;
  return undefined;
}

function conditionStart(tokens, pairs, end) {
  let start = end;
  while (start > 0) {
    const previous = tokens[start - 1];
    if ([')', ']'].includes(previous)) start = pairs.get(start - 1);
    else if ([';', '=', ',', ':', '?', 'return', '=>', '{', '}', '(', '['].includes(previous)) break;
    else start -= 1;
  }
  return start;
}

function expressionEnd(tokens, pairs, start, logical = false) {
  let nestedConditionals = 0;
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (['(', '[', '{'].includes(token)) i = pairs.get(i);
    else if ([';', ',', ')', ']', '}'].includes(token)) return i;
    else if (logical && nestedConditionals === 0 && ['||', '??', '?'].includes(token)) return i;
    else if (token === '?') nestedConditionals += 1;
    else if (token === ':') {
      if (nestedConditionals === 0) return i;
      nestedConditionals -= 1;
    }
  }
  return tokens.length;
}

// Recognize direct process.mas guards independent of whitespace, comments,
// quote style, braces, and if/else versus conditional/short-circuit expressions.
function masRegions({ tokens, pairs }) {
  const regions = [];
  const statementEnd = start => tokens[start] === '{'
    ? pairs.get(start) + 1 : expressionEnd(tokens, pairs, start);
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === 'if' && tokens[i + 1] === '(') {
      const close = pairs.get(i + 1);
      const mas = masPredicate(tokens.slice(i + 2, close));
      if (mas === undefined) continue;
      const start = close + 1;
      const end = statementEnd(start);
      regions.push({ mas, start, end, kind: 'statement' });
      const next = end + (tokens[end] === ';' ? 1 : 0);
      if (tokens[next] === 'else') {
        regions.push({ mas: !mas, start: next + 1, end: statementEnd(next + 1), kind: 'statement' });
      }
    } else if (['?', '&&', '||'].includes(tokens[i])) {
      const start = conditionStart(tokens, pairs, i);
      const mas = masPredicate(tokens.slice(start, i));
      if (mas === undefined) continue;
      if (tokens[i] === '?') {
        const colon = expressionEnd(tokens, pairs, i + 1);
        if (tokens[colon] !== ':') continue;
        regions.push({ mas, start: i + 1, end: colon, kind: 'expression' });
        regions.push({ mas: !mas, start: colon + 1, end: expressionEnd(tokens, pairs, colon + 1), kind: 'expression' });
      } else {
        regions.push({
          mas: tokens[i] === '&&' ? mas : !mas,
          start: i + 1,
          end: expressionEnd(tokens, pairs, i + 1, true),
          kind: 'expression',
        });
      }
    }
  }
  return regions;
}

function requiresOf(tokens, moduleName, loader = 'require') {
  const positions = [];
  for (let i = 0; i < tokens.length - 3; i += 1) {
    if (tokens[i] === loader && tokens[i + 1] === '(' && tokens[i + 3] === ')' &&
        /^['"]/.test(tokens[i + 2]) && tokens[i + 2].slice(1, -1).replace(/\.js$/, '') === moduleName) positions.push(i);
  }
  return positions;
}

function importedBindings({ tokens, pairs }, positions) {
  const bindings = new Set();
  for (const position of positions) {
    if (tokens[position - 1] !== '=') continue;
    const last = position - 2;
    if (identifier.test(tokens[last] || '')) bindings.add(tokens[last]);
    else if (tokens[last] === '}') {
      const members = tokens.slice(pairs.get(last) + 1, last).join(' ').split(',');
      for (const member of members) {
        const parts = member.trim().split(/\s+/);
        const colon = parts.indexOf(':');
        const binding = parts[colon === -1 ? 0 : colon + 1];
        if (identifier.test(binding || '')) bindings.add(binding);
      }
    }
  }
  return bindings;
}

function positiveResourcePaths(value) {
  if (typeof value === 'string') return value.startsWith('!') ? [] : [value];
  if (Array.isArray(value)) return value.flatMap(positiveResourcePaths);
  if (value && typeof value === 'object') return Object.values(value).flatMap(positiveResourcePaths);
  return [];
}

function assertPlistTrue(xml, key, filename) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyTag = `<key>\\s*${escaped}\\s*<\\/key>`;
  assert.equal([...xml.matchAll(new RegExp(keyTag, 'g'))].length, 1, `${filename}: exactly one ${key}`);
  assert.match(xml, new RegExp(`${keyTag}\\s*<true\\s*\\/\\s*>`), `${filename}: ${key} must be boolean true`);
}

test('MAS build derives a universal, signed TestFlight distribution from package.json', () => {
  const base = require('../package.json').build;
  const before = JSON.parse(JSON.stringify(base));
  const config = require('../electron-builder.mas.cjs');
  assert.ok(config && typeof config === 'object' && !Array.isArray(config), 'export a static configuration object, not a factory');
  assert.deepEqual(base, before, 'loading the MAS configuration must not mutate the desktop build');
  for (const key of ['appId', 'productName', 'copyright', 'protocols', 'directories']) {
    assert.deepEqual(config[key], before[key], `retain package.json build.${key}`);
  }
  for (const key of ['category', 'icon']) assert.equal(config.mac?.[key], before.mac[key]);
  assert.deepEqual(config.mac?.target, [{ target: 'mas', arch: ['universal'] }]);
  assert.equal(config.mas?.type, 'distribution');
  assert.equal(config.mas?.entitlements, 'entitlements.mas.plist');
  assert.equal(config.mas?.entitlementsInherit, 'entitlements.mas.inherit.plist');
  assert.equal(config.forceCodeSigning, true, 'an unsigned DMG is not a TestFlight build');
  assert.equal(config.publish, null, 'MAS releases must not publish updater artifacts');
  assert.equal(config.afterSign, 'scripts/verify-mas-signature.cjs');
  assert.equal(config.mac?.hardenedRuntime, false);
  assert.doesNotMatch(JSON.stringify(config), /scripts[\\/]+notarize\.(?:c?js|mjs)/i, 'do not inherit the ad-hoc notarization hook');
  for (const key of ['extraResources', 'extraFiles', 'files']) {
    assert.doesNotMatch(positiveResourcePaths(config[key]).join('\n'), runtimeInstaller, `${key}: do not ship a downloadable browser runtime or installer`);
  }
});

test('MAS parent and child entitlements enforce sandboxing without disabling library validation', () => {
  const parentName = 'entitlements.mas.plist';
  const childName = 'entitlements.mas.inherit.plist';
  const parent = read(parentName).replace(/<!--[\s\S]*?-->/g, '');
  const child = read(childName).replace(/<!--[\s\S]*?-->/g, '');
  for (const [filename, xml] of [[parentName, parent], [childName, child]]) {
    assert.match(xml, /<plist\b[^>]*>\s*<dict\b/, `${filename}: an XML entitlement dictionary`);
    assertPlistTrue(xml, 'com.apple.security.app-sandbox', filename);
    assert.doesNotMatch(xml, /<key>\s*com\.apple\.security\.cs\.disable-library-validation\s*<\/key>/, `${filename}: no library-validation bypass, even when set to false`);
  }
  assertPlistTrue(parent, 'com.apple.security.network.client', parentName);
  assertPlistTrue(child, 'com.apple.security.inherit', childName);
});

test('every electron-updater load in main.js is confined to a non-MAS branch', () => {
  const main = source('src/main.js');
  const updaterLoads = [
    ...requiresOf(main.tokens, 'electron-updater'),
    ...requiresOf(main.tokens, 'electron-updater', 'import'),
  ];
  assert.ok(updaterLoads.length > 0, 'retain the non-MAS updater without loading it for MAS');
  const nonMas = masRegions(main).filter(region => region.mas === false);
  for (const position of updaterLoads) {
    assert.ok(nonMas.some(region => position >= region.start && position < region.end), 'electron-updater must only load behind a process.mas exclusion');
  }
  assert.doesNotMatch(main.tokens.join(' '), /\b(?:import|export)\b[^;]*\bfrom\s*['"]electron-updater['"]|\bimport\s*['"]electron-updater['"]/, 'static updater imports cannot be guarded for MAS');
});

test('the MAS native browser uses Electron in-process without subprocesses, debug ports, listeners, or runtime installation', () => {
  const native = source('src/in-app-browser.js').tokens.join(' ');
  assert.match(native, /\b(?:WebContentsView|BrowserView|BrowserWindow|webContents)\b/, 'use an Electron-owned native browser');
  assert.doesNotMatch(native, /\b(?:spawn(?:Sync)?|execFile(?:Sync)?|child_process)\b/, 'no subprocess browser or runtime launcher');
  assert.doesNotMatch(native, /remote-debugging-port/i, 'do not expose a remote-debugging port');
  assert.doesNotMatch(native, /\blisten\s*(?:\?\.\s*)?\(/, 'no loopback approval or browser-control listener');
  assert.doesNotMatch(native, runtimeInstaller, 'no external browser-runtime download or installation');
});

test('desktop-browser-service selects and returns the in-process browser for MAS, not the legacy socket/runtime path', () => {
  const service = source('src/desktop-browser-service.js');
  const nativeRequires = requiresOf(service.tokens, './in-app-browser');
  assert.ok(nativeRequires.length > 0, 'wire the MAS native browser module into the public service');
  const bindings = importedBindings(service, nativeRequires);
  const selected = masRegions(service).filter(region => {
    if (region.mas !== true) return false;
    if (nativeRequires.some(position => position >= region.start && position < region.end)) return true;
    return service.tokens.slice(region.start, region.end).some((token, offset, tokens) => {
      if (!bindings.has(token)) return false;
      if (region.kind === 'expression') return true;
      let next = offset + 1;
      while (tokens[next] === '.' || tokens[next] === '?.') next += 2;
      return tokens[next] === '(';
    });
  });
  assert.ok(selected.length > 0, 'a process.mas branch must select the imported native factory, regardless of its local binding name');
  for (const region of selected) {
    const tokens = service.tokens.slice(region.start, region.end);
    if (region.kind === 'statement') assert.ok(tokens.includes('return'), 'return the MAS service instead of falling through to the legacy runtime');
    const code = tokens.join(' ');
    assert.doesNotMatch(code, runtimeInstaller, 'MAS must not download, install, or ensure an external browser runtime');
    assert.doesNotMatch(code, /approval[\w.-]*(?:socket|server)|(?:socket|server)[\w.-]*approval|\blisten\s*\(/i, 'MAS must not create the legacy approval socket');
  }
});
