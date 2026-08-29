import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryMarketplaceWriteLimiter } from '../server/abuse/memoryWriteLimiter.ts';
import {
  DEFAULT_MARKETPLACE_WRITE_POLICIES,
  parseMarketplaceWritePolicies,
} from '../server/abuse/policy.ts';
import { marketplaceNetworkSource, marketplaceWriteLimitDenied } from '../server/abuse/writeLimiter.ts';

test('write-limit policy supports private per-operation overrides and rejects invalid values', () => {
  const configured = parseMarketplaceWritePolicies({
    MARKETPLACE_WRITE_LIMIT_POLICY: JSON.stringify({
      report: {
        member: { refillPerMinute: 0.5, burst: 2 },
        network: { refillPerMinute: 3, burst: 9 },
      },
    }),
  });
  assert.deepEqual(configured.report, {
    member: { refillPerMinute: 0.5, burst: 2 },
    network: { refillPerMinute: 3, burst: 9 },
  });
  assert.deepEqual(configured.publish, DEFAULT_MARKETPLACE_WRITE_POLICIES.publish);
  assert.deepEqual(
    parseMarketplaceWritePolicies({ MARKETPLACE_WRITE_LIMIT_POLICY: '{"like":{"member":{}}}' }),
    DEFAULT_MARKETPLACE_WRITE_POLICIES,
  );
});

test('dual token buckets isolate operations and require both member and network capacity', async () => {
  const limiter = createMemoryMarketplaceWriteLimiter({
    publish: {
      member: { refillPerMinute: 1, burst: 1 },
      network: { refillPerMinute: 1, burst: 2 },
    },
    revision: {
      member: { refillPerMinute: 1, burst: 1 },
      network: { refillPerMinute: 1, burst: 1 },
    },
  });
  const now = new Date('2026-08-29T10:00:00.000Z');
  const consume = (operation: 'publish' | 'revision', memberId: string, networkSource: string) => (
    limiter.consume({ operation, memberId, networkSource, now })
  );

  assert.deepEqual(await consume('publish', 'member-a', '198.51.100.1'), { allowed: true });
  assert.equal((await consume('publish', 'member-a', '198.51.100.2')).allowed, false);
  assert.deepEqual(await consume('revision', 'member-a', '198.51.100.1'), { allowed: true });
  assert.equal((await consume('publish', 'member-b', '198.51.100.1')).allowed, true);
  assert.equal((await consume('publish', 'member-c', '198.51.100.1')).allowed, false);
});

test('limit response exposes a stable retry contract and reads the first forwarded address', async () => {
  const limiter = createMemoryMarketplaceWriteLimiter({
    report: {
      member: { refillPerMinute: 1, burst: 1 },
      network: { refillPerMinute: 1, burst: 1 },
    },
  });
  const request = new Request('https://pedalboard.test/api/marketplace/reports', {
    headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
  });
  const now = new Date('2026-08-29T10:00:00.000Z');
  assert.equal(marketplaceNetworkSource(request), '203.0.113.7');
  assert.equal(await marketplaceWriteLimitDenied({ limiter, operation: 'report', memberId: 'member-a', request, now }), null);
  const denied = await marketplaceWriteLimitDenied({ limiter, operation: 'report', memberId: 'member-a', request, now });
  assert.equal(denied?.status, 429);
  assert.equal(denied?.headers.get('retry-after'), '60');
  assert.deepEqual(await denied?.json(), { error: {
    code: 'write_rate_limited', message: 'Community write rate limit reached',
    operation: 'report', retryAt: '2026-08-29T10:01:00.000Z',
  } });
});
