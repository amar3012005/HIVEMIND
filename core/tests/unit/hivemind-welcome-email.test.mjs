import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderTemplate } from '../../src/email/email-service.js';

test('new-account welcome renders the Cartesia product hero with a safe app link', () => {
  const rendered = renderTemplate('welcome_signup', {
    name: '<Maya>',
    appUrl: 'https://next.singulancelabs.com/hivemind/app?from=welcome&safe=1',
  });

  assert.match(rendered.html, /Run your institution/);
  assert.match(rendered.html, /as an AI company/);
  assert.match(rendered.html, /SOVEREIGN MEMORY ENGINE · EU/);
  assert.match(rendered.html, /What was the deployment fix from last Tuesday/);
  assert.match(rendered.html, /Welcome to HIVEMIND, &lt;Maya&gt;/);
  assert.doesNotMatch(rendered.html, /Welcome to HIVEMIND, <Maya>/);
  assert.match(rendered.html, /https:\/\/next\.singulancelabs\.com\/hivemind\/app\?from=welcome&amp;safe=1/);
});

test('welcome renderer includes compact mobile rules without hiding product content', () => {
  const rendered = renderTemplate('welcome_signup', { name: 'Maya' });

  assert.match(rendered.html, /@media only screen and \(max-width:620px\)/);
  assert.match(rendered.html, /\.hm-shell\{width:100%!important/);
  assert.match(rendered.html, /Memories/);
  assert.match(rendered.html, /Knowledge Base/);
  assert.match(rendered.html, /Web Intel/);
  assert.match(rendered.html, /&lt;50ms/);
  assert.match(rendered.html, /A memory that/);
  assert.match(rendered.html, /Context-savvy accuracy/);
  assert.match(rendered.html, /Meetings become/);
  assert.match(rendered.html, /Digital employees/);
  assert.match(rendered.html, /A voice that/);
  assert.match(rendered.html, /Your editor/);
  assert.match(rendered.html, /Memory stays inside your walls/);
  assert.match(rendered.html, /Encryption that outlives/);
  assert.match(rendered.html, /https:\/\/next\.singulancelabs\.com\/email\/welcome-cartesia\/v1\/hero@2x\.png/);
  assert.match(rendered.html, /width="760"/);
});
