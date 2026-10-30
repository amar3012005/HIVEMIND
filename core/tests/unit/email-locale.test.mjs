import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderTemplate } from '../../src/email/email-service.js';
import { readEmailLocale, resolveEmailLocale } from '../../src/email/email-locale.js';

const locales = JSON.parse(readFileSync(new URL('../../src/email/templates.locales.json', import.meta.url), 'utf8'));
const templates = JSON.parse(readFileSync(new URL('../../src/email/templates.json', import.meta.url), 'utf8'));
const placeholders = text => [...String(text).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(match => match[1]).sort().join(',');

test('profile language first, then the organization default, then English; the profile default en does not outrank an organization default', () => {
  assert.equal(resolveEmailLocale({ profile: 'ja', org: 'de' }), 'ja');
  assert.equal(resolveEmailLocale({ profile: 'en', org: 'de' }), 'de');
  assert.equal(resolveEmailLocale({ profile: null, org: 'de-AT' }), 'de');
  assert.equal(resolveEmailLocale({ profile: 'fr', org: null }), 'en');
  assert.equal(resolveEmailLocale({ profile: 'en', org: null }), 'en');
  assert.equal(resolveEmailLocale(), 'en');
});

test('readEmailLocale reads the profile and organization rows and never throws', async () => {
  const db = { $queryRawUnsafe: async (sql) => /FROM hivemind\.users/.test(sql) ? [{ locale: 'en' }] : [{ default_locale: 'hi' }] };
  assert.equal(await readEmailLocale(db, { userId: 'u', orgId: 'o' }), 'hi');
  assert.equal(await readEmailLocale({ $queryRawUnsafe: async () => { throw new Error('column missing'); } }, { userId: 'u', orgId: 'o' }), 'en');
  assert.equal(await readEmailLocale(null, { userId: 'u' }), 'en');
});

test('every variant keeps the placeholders of the English template and only overrides known fields', () => {
  for (const [id, byLocale] of Object.entries(locales).filter(([id]) => id !== '_meta')) {
    for (const [locale, variant] of Object.entries(byLocale)) {
      assert.ok(['de', 'hi', 'ja', 'ar'].includes(locale), `${id}: ${locale}`);
      for (const [field, value] of Object.entries(variant)) {
        assert.ok(['subject', 'preheader', 'text', 'html'].includes(field), `${id}.${locale}.${field}`);
        assert.equal(placeholders(value), placeholders(templates[id][field]), `${id}.${locale}.${field} placeholders`);
      }
    }
  }
});

test('a localized template renders in the language, escapes values, and falls back to English', () => {
  const vars = { name: 'Amar <b>', appUrl: 'https://app.example', year: 2026 };
  const de = renderTemplate('welcome_login', { ...vars, locale: 'de' });
  assert.match(de.subject, /Willkommen zurück bei HIVEMIND, Amar <b>/);
  assert.match(de.html, /Amar &lt;b&gt;/);
  assert.doesNotMatch(de.html, /dir="rtl"/);
  const ar = renderTemplate('welcome_login', { ...vars, locale: 'ar' });
  assert.match(ar.html, /dir="rtl"/);
  assert.match(ar.subject, /مرحبًا بعودتك/);
  const en = renderTemplate('welcome_login', vars);
  assert.match(en.subject, /Welcome back to HIVEMIND/);
  assert.equal(renderTemplate('welcome_login', { ...vars, locale: 'fr' }).subject, en.subject);
  assert.equal(renderTemplate('welcome_login', { ...vars, locale: 'en' }).html, en.html);
  // A template without variants stays English whatever the language.
  assert.equal(renderTemplate('announcement', { subject: 'S', heading: 'H', body: 'B', locale: 'ja' }).subject, 'S');
});

test('the proactive reflection and invitation confirmation render in every shipped language', () => {
  for (const locale of ['de', 'hi', 'ja', 'ar']) {
    const reflection = renderTemplate('proactive_decision_reflection', { name: 'Maya', focusTitle: 'Q4 plan', appUrl: 'https://app.example', locale });
    assert.ok(reflection.html.includes('Q4 plan') && reflection.text.includes('Maya'), locale);
    assert.notEqual(reflection.subject, 'A thought worth carrying forward');
    const invite = renderTemplate('team_invite_admin_confirmation', { inviterName: 'Maya', inviteeEmail: 'a@b.co', orgName: 'Acme', deliveryState: 'accepted', expiresOn: '2026-11-01', appUrl: 'https://app.example', locale });
    assert.ok(invite.subject.includes('a@b.co'), locale);
    assert.ok(invite.html.includes('/workspace?tab=invites'), locale);
  }
});
