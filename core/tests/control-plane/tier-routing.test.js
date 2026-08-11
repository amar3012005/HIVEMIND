import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOrigins, resolveTierCore } from '../../src/control-plane/tier-routing.js';

const defaults = {
  defaultInternalUrl: 'http://core:3000',
  defaultPublicUrl: 'https://core.singulancelabs.com',
  b2bInternalUrl: 'http://core-b2b:3000',
  b2bPublicUrl: 'https://b2b-core.singulancelabs.com',
  b2cInternalUrl: 'http://core-b2c:3000',
  b2cPublicUrl: 'https://b2c-core.singulancelabs.com',
};

test('tier routing only activates for explicitly allowed frontend origins', () => {
  const routingOrigins = parseOrigins('https://next.singulancelabs.com');
  assert.deepEqual(resolveTierCore({ ...defaults, routingOrigins, origin: 'https://other.example', plan: 'enterprise' }), {
    internalUrl: defaults.defaultInternalUrl,
    publicUrl: defaults.defaultPublicUrl,
    tier: 'default',
  });
});

test('tier routing sends paid plans to B2B and free plans to B2C', () => {
  const routingOrigins = ['https://next.singulancelabs.com'];
  assert.equal(resolveTierCore({ ...defaults, routingOrigins, origin: routingOrigins[0], plan: 'enterprise' }).tier, 'b2b');
  assert.equal(resolveTierCore({ ...defaults, routingOrigins, origin: routingOrigins[0], plan: 'free' }).tier, 'b2c');
});

test('tier routing fails back to the current core until both tier URLs are configured', () => {
  const result = resolveTierCore({ ...defaults, routingOrigins: ['https://next.singulancelabs.com'], origin: 'https://next.singulancelabs.com', plan: 'free', b2cPublicUrl: '' });
  assert.equal(result.tier, 'default');
});
