import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HUMATION_AVATAR_ASSET_VERSION,
  humationAvatarPublicUrl,
  humationLaneVisual,
  renderHumationAvatarSvg,
} from '../../src/email/humation-avatar.js';
import { DAY_ZERO_REPORT_VERSION, renderDayZeroOnboardingEmail } from '../../src/email/templates/day0-company-onboarding.js';

test('Humation email SVG bakes lane colors without CSS-variable fallbacks', () => {
  const svg = renderHumationAvatarSvg({ id: 'researcher-1', name: 'Léa', roleArchetype: 'Researcher' });
  assert.match(svg, /#10B981/);
  assert.doesNotMatch(svg, /fill="var\(--hm-/);
  assert.match(svg, /fill="#10B981"/);
});

test('Humation lane visuals match the product palette', () => {
  assert.deepEqual(humationLaneVisual('researcher'), {
    lane: 'Researcher', color: '#10b981', background: '#e8f8f2',
  });
  assert.deepEqual(humationLaneVisual('risk and compliance'), {
    lane: 'Skeptic', color: '#f59e0b', background: '#fff7e6',
  });
});

test('public avatar URLs carry the immutable asset version', () => {
  assert.equal(HUMATION_AVATAR_ASSET_VERSION, '2');
  assert.equal(
    humationAvatarPublicUrl({ id: 'builder-1', roleArchetype: 'Builder' }, 'https://api.example.test/'),
    'https://api.example.test/v1/public/humation-avatar.svg?seed=builder-1&role=Builder&v=2',
  );
});

test('Day 0 uses the same lane-colored, cache-versioned email contract', () => {
  const rendered = renderDayZeroOnboardingEmail({
    company: 'Canary Co',
    website: 'https://canary.example',
    source_pages: [{ url: 'https://canary.example/products' }],
    team: [{ id: 'builder-1', name: 'Mina', roleArchetype: 'builder', jobTitle: 'Engineer' }],
  }, { publicApiUrl: 'https://api.example.test' });
  assert.equal(rendered.report.version, DAY_ZERO_REPORT_VERSION);
  assert.match(rendered.html, /role=Builder&amp;v=2/);
  assert.match(rendered.html, /class="avatar" style="background:#eaf3ff;border-color:#117dff"/);
  assert.match(rendered.html, /class="person-role" style="color:#117dff"/);
  assert.match(rendered.html, /class="character-strip"/);
  assert.match(rendered.html, /EVIDENCE LEDGER/);
});
