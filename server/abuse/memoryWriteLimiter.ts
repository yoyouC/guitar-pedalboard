import type { MarketplaceWriteLimiter, MarketplaceWritePolicies, TokenBucketPolicy } from './writeLimiter.js';

interface Bucket { tokens: number; updatedAt: number }

function idleTtlMs(policy: { member: TokenBucketPolicy; network: TokenBucketPolicy }): number {
  return Math.ceil(Math.max(
    policy.member.burst / policy.member.refillPerMinute,
    policy.network.burst / policy.network.refillPerMinute,
  ) * 60_000);
}

export function createMemoryMarketplaceWriteLimiter(
  policies: MarketplaceWritePolicies,
): MarketplaceWriteLimiter {
  const buckets = new Map<string, Bucket>();
  const inspect = (key: string, policy: TokenBucketPolicy, now: number) => {
    const previous = buckets.get(key) ?? { tokens: policy.burst, updatedAt: now };
    return {
      tokens: Math.min(
        policy.burst,
        previous.tokens + Math.max(0, now - previous.updatedAt) * policy.refillPerMinute / 60_000,
      ),
      updatedAt: now,
    };
  };
  return {
    async consume(input) {
      const policy = policies[input.operation];
      if (!policy) return { allowed: true };
      const now = input.now.getTime();
      const operationPrefix = `${input.operation}:`;
      const expiresBefore = now - idleTtlMs(policy);
      for (const [key, bucket] of buckets) {
        if (key.startsWith(operationPrefix) && bucket.updatedAt <= expiresBefore) buckets.delete(key);
      }
      const candidates = [
        { key: `${input.operation}:member:${input.memberId}`, policy: policy.member },
        { key: `${input.operation}:network:${input.networkSource}`, policy: policy.network },
      ].map((item) => ({ ...item, bucket: inspect(item.key, item.policy, now) }));
      const denied = candidates.filter((item) => item.bucket.tokens < 1);
      if (denied.length > 0) {
        const retryAt = Math.max(...denied.map((item) => (
          now + (1 - item.bucket.tokens) * 60_000 / item.policy.refillPerMinute
        )));
        candidates.forEach((item) => buckets.set(item.key, item.bucket));
        return { allowed: false, retryAt: new Date(Math.ceil(retryAt)) };
      }
      candidates.forEach((item) => buckets.set(item.key, {
        tokens: item.bucket.tokens - 1, updatedAt: now,
      }));
      return { allowed: true };
    },
    async purgeMember(memberId) {
      const suffix = `:member:${memberId}`;
      for (const key of buckets.keys()) {
        if (key.endsWith(suffix)) buckets.delete(key);
      }
    },
  };
}
