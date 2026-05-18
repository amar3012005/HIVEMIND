import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AdapterRegistry } from '../../src/connectors/framework/adapter-registry.js';

class FakeAdapter {
  constructor(ctx) { this.ctx = ctx; }
}
class FakeAdapter2 {
  constructor(ctx) { this.ctx = ctx; }
}

describe('AdapterRegistry', () => {
  let registry;
  beforeEach(() => { registry = new AdapterRegistry(); });

  // register / get
  it('registers and retrieves an adapter class by providerKey', () => {
    registry.register('slack', FakeAdapter);
    assert.equal(registry.get('slack'), FakeAdapter);
  });

  it('returns null for an unregistered providerKey', () => {
    assert.equal(registry.get('nonexistent'), null);
  });

  // list
  it('lists all registered provider keys', () => {
    registry.register('slack', FakeAdapter);
    registry.register('notion', FakeAdapter2);
    const keys = registry.list();
    assert.ok(keys.includes('slack'));
    assert.ok(keys.includes('notion'));
    assert.equal(keys.length, 2);
  });

  it('returns empty array when no adapters registered', () => {
    assert.deepEqual(registry.list(), []);
  });

  // instantiate
  it('instantiates the adapter with the supplied context', () => {
    registry.register('slack', FakeAdapter);
    const ctx = { tokenResolver: () => {}, prisma: {}, logger: console };
    const instance = registry.instantiate('slack', ctx);
    assert.ok(instance instanceof FakeAdapter);
    assert.equal(instance.ctx.providerKey, 'slack');
  });

  it('throws when instantiating an unregistered provider', () => {
    assert.throws(
      () => registry.instantiate('ghost', {}),
      /no adapter registered for "ghost"/,
    );
  });

  // override / warning
  it('overrides the adapter when the same key is registered twice', () => {
    registry.register('slack', FakeAdapter);
    registry.register('slack', FakeAdapter2); // should warn + override
    assert.equal(registry.get('slack'), FakeAdapter2);
  });
});
