/**
 * Smoke tests for web-policy.js
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  validateDomain,
  filterContent,
  UserRateLimiter,
  detectAbuse,
  getRobotsWarning,
} from '../../src/web/web-policy.js';

describe('validateDomain', () => {
  it('blocks localhost', () => {
    const r = validateDomain('http://localhost:3000/path');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/internal/i);
  });

  it('blocks private IPs', () => {
    expect(validateDomain('http://192.168.1.1').allowed).toBe(false);
    expect(validateDomain('http://10.0.0.5').allowed).toBe(false);
    expect(validateDomain('http://127.0.0.1:8080').allowed).toBe(false);
  });

  it('blocks known adult domains', () => {
    const r = validateDomain('https://pornhub.com/something');
    expect(r.allowed).toBe(false);
  });

  it('allows normal domains', () => {
    expect(validateDomain('https://example.com').allowed).toBe(true);
    expect(validateDomain('https://docs.github.com').allowed).toBe(true);
  });

  it('respects user denylist', () => {
    const r = validateDomain('https://example.com', { denylist: ['example.com'] });
    expect(r.allowed).toBe(false);
  });

  it('respects user allowlist overriding blocked domains (not internal IPs)', () => {
    // Internal IPs cannot be overridden by allowlist (security)
    expect(validateDomain('http://localhost', { allowlist: ['localhost'] }).allowed).toBe(false);
    // But blocked content domains CAN be overridden by explicit allowlist
    expect(validateDomain('https://pornhub.com').allowed).toBe(false);
    const r = validateDomain('https://pornhub.com', { allowlist: ['pornhub.com'] });
    expect(r.allowed).toBe(true);
  });

  it('rejects non-http schemes', () => {
    expect(validateDomain('ftp://files.example.com').allowed).toBe(false);
    expect(validateDomain('javascript:alert(1)').allowed).toBe(false);
  });
});

describe('filterContent', () => {
  it('strips script tags', () => {
    const r = filterContent('hello <script>alert(1)</script> world');
    expect(r.text).not.toContain('<script>');
    expect(r.text).toContain('hello');
    expect(r.text).toContain('world');
    expect(r.filtered_count).toBeGreaterThan(0);
  });

  it('strips iframes', () => {
    const r = filterContent('before <iframe src="evil.html"></iframe> after');
    expect(r.text).not.toContain('<iframe');
  });

  it('truncates long content', () => {
    const long = 'x'.repeat(600_000);
    const r = filterContent(long);
    expect(r.text.length).toBeLessThanOrEqual(512_000 + 100); // 500KB + some margin
  });

  it('passes clean text through', () => {
    const r = filterContent('Just normal text');
    expect(r.text).toBe('Just normal text');
    expect(r.filtered_count).toBe(0);
  });
});

describe('UserRateLimiter', () => {
  let limiter;
  beforeEach(() => {
    limiter = new UserRateLimiter({ maxPerMinute: 3, maxPerHour: 10 });
  });

  it('allows requests under limit', () => {
    limiter.record('user1');
    limiter.record('user1');
    expect(limiter.check('user1').allowed).toBe(true);
  });

  it('blocks at minute limit', () => {
    for (let i = 0; i < 3; i++) limiter.record('user2');
    expect(limiter.check('user2').allowed).toBe(false);
    expect(limiter.check('user2').retryAfterMs).toBeGreaterThan(0);
  });

  it('resets user', () => {
    for (let i = 0; i < 3; i++) limiter.record('user3');
    expect(limiter.check('user3').allowed).toBe(false);
    limiter.reset('user3');
    expect(limiter.check('user3').allowed).toBe(true);
  });

  it('isolates users', () => {
    for (let i = 0; i < 3; i++) limiter.record('userA');
    expect(limiter.check('userA').allowed).toBe(false);
    expect(limiter.check('userB').allowed).toBe(true);
  });
});

describe('detectAbuse', () => {
  it('allows normal requests', () => {
    const r = detectAbuse({ userId: 'u1', type: 'search', query: 'hello', recentJobCount: 5 });
    expect(r.action).toBe('allow');
  });

  it('warns on high recent job count', () => {
    const r = detectAbuse({ userId: 'u1', type: 'search', query: 'hello', recentJobCount: 25 });
    expect(r.action).not.toBe('allow');
  });

  it('blocks extreme job count', () => {
    const r = detectAbuse({ userId: 'u1', type: 'crawl', urls: ['https://a.com'], recentJobCount: 60 });
    expect(r.action).toBe('block');
  });

  it('flags suspiciously long queries', () => {
    const long = 'a'.repeat(2500);
    const r = detectAbuse({ userId: 'u1', type: 'search', query: long, recentJobCount: 1 });
    expect(r.suspicious).toBe(true);
  });
});

describe('getRobotsWarning', () => {
  it('warns for known restricted domains', () => {
    const r = getRobotsWarning('https://twitter.com/user');
    expect(r.advisory).toBe(true);
    expect(r.warning).toBeTruthy();
  });

  it('no warning for unrestricted domains', () => {
    const r = getRobotsWarning('https://example.com');
    expect(r.advisory).toBe(false);
  });
});
