import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderTemplate } from '../../src/email/email-service.js';

test('new-account welcome renders the personalized message with a safe app link', () => {
  const rendered = renderTemplate('welcome_signup', {
    name: '<Maya>',
    appUrl: 'https://next.singulancelabs.com/hivemind/app?from=welcome&safe=1',
  });

  assert.match(rendered.html, /Welcome to your HIVEMIND, &lt;Maya&gt;/);
  assert.doesNotMatch(rendered.html, /Welcome to your HIVEMIND, <Maya>/);
  assert.match(rendered.html, /https:\/\/next\.singulancelabs\.com\/hivemind\/app\?from=welcome&amp;safe=1/);
});

test('welcome renderer is self-contained and renders one footer', () => {
  const rendered = renderTemplate('welcome_signup', { name: 'Maya' });

  assert.match(rendered.html, /@media only screen and \(max-width:620px\)/);
  assert.match(rendered.html, /\.hm-shell\{width:100%!important/);
  assert.equal((rendered.html.match(/SINGULANCE · HIVEMIND · OPERATING SYSTEM/g) || []).length, 1);
  assert.doesNotMatch(rendered.html, /welcome-cartesia/);
  assert.equal((rendered.html.match(/<img\b/gi) || []).length, 1);
});
