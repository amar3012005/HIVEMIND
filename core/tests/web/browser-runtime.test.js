/**
 * Smoke tests for browser-runtime.js reliability features
 */
import { describe, it, expect } from 'vitest';
import { BrowserRuntime, getTelemetry, DomainConcurrencyTracker, CircuitBreaker } from '../../src/web/browser-runtime.js';

describe('DomainConcurrencyTracker', () => {
  it('acquires and releases slots', () => {
    const tracker = new DomainConcurrencyTracker(2);
    expect(tracker.acquire('example.com')).toBe(true);
    expect(tracker.acquire('example.com')).toBe(true);
    expect(tracker.acquire('example.com')).toBe(false); // at cap
    tracker.release('example.com');
    expect(tracker.acquire('example.com')).toBe(true);
  });

  it('tracks different domains independently', () => {
    const tracker = new DomainConcurrencyTracker(1);
    expect(tracker.acquire('a.com')).toBe(true);
    expect(tracker.acquire('b.com')).toBe(true);
    expect(tracker.acquire('a.com')).toBe(false);
  });

  it('returns active map snapshot', () => {
    const tracker = new DomainConcurrencyTracker(3);
    tracker.acquire('x.com');
    tracker.acquire('x.com');
    const active = tracker.getActive();
    expect(active.get('x.com')).toBe(2);
  });
});

describe('CircuitBreaker', () => {
  it('starts closed', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 100 });
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState().state).toBe('CLOSED');
  });

  it('opens after threshold failures', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 100 });
    cb.recordFailure();
    expect(cb.isOpen()).toBe(false);
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
    expect(cb.getState().state).toBe('OPEN');
  });

  it('transitions to half-open after reset timeout', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
    await new Promise(r => setTimeout(r, 60));
    expect(cb.isOpen()).toBe(false); // half-open allows through
    expect(cb.getState().state).toBe('HALF_OPEN');
  });

  it('closes on success after half-open', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });
    cb.recordFailure();
    await new Promise(r => setTimeout(r, 60));
    cb.recordSuccess();
    expect(cb.getState().state).toBe('CLOSED');
  });

  it('resets failure count on success', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 100 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.getState().failures).toBe(0);
  });
});

describe('getTelemetry', () => {
  it('returns a snapshot object', () => {
    const t = getTelemetry();
    expect(t).toHaveProperty('totalJobs');
    expect(t).toHaveProperty('lightpandaSuccesses');
    expect(t).toHaveProperty('fallbackSuccesses');
    expect(t).toHaveProperty('circuitBreakerTrips');
    expect(t).toHaveProperty('uptime_ms');
    expect(typeof t.uptime_ms).toBe('number');
  });
});

describe('BrowserRuntime', () => {
  it('can be instantiated', () => {
    const rt = new BrowserRuntime();
    expect(rt).toBeTruthy();
  });
});
