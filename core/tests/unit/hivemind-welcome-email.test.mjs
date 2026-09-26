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
  assert.equal((rendered.html.match(/<img\b/gi) || []).length, 4);
  assert.match(rendered.html, /humation-avatar\.svg\?seed=hivemind-brain/);
  assert.match(rendered.html, /humation-avatar\.svg\?seed=hivemind-os/);
  assert.match(rendered.html, /humation-avatar\.svg\?seed=hivemind-voice/);
  assert.match(rendered.html, /width:48px;height:48px;border:0/);
  assert.doesNotMatch(rendered.html, /max-width:none;margin:-8px 0 0 -12px/);
});

test('ICARUS developer welcome clearly separates developer identity from platform tenancy', () => {
  const rendered = renderTemplate('icarus_developer_connected', { name: 'Maya' });
  assert.match(rendered.subject, /ICARUS is connected/);
  assert.match(rendered.text, /no HIVEMIND workspace, personal plan, or enterprise account was created/i);
  assert.match(rendered.html, /ICARUS · DEVELOPER MODE/);
  assert.match(rendered.html, /Best of luck building/);
});
