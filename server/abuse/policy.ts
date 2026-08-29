import type { MarketplaceWriteOperation, MarketplaceWritePolicies, TokenBucketPolicy } from './writeLimiter.ts';

export const DEFAULT_MARKETPLACE_WRITE_POLICIES: Record<MarketplaceWriteOperation, {
  member: TokenBucketPolicy;
  network: TokenBucketPolicy;
}> = {
  publish: { member: { refillPerMinute: 1, burst: 3 }, network: { refillPerMinute: 5, burst: 15 } },
  revision: { member: { refillPerMinute: 4, burst: 8 }, network: { refillPerMinute: 12, burst: 24 } },
  like: { member: { refillPerMinute: 20, burst: 40 }, network: { refillPerMinute: 60, burst: 120 } },
  report: { member: { refillPerMinute: 1, burst: 3 }, network: { refillPerMinute: 6, burst: 12 } },
};

export function parseMarketplaceWritePolicies(environment: Record<string, string | undefined>): MarketplaceWritePolicies {
  const raw = environment.MARKETPLACE_WRITE_LIMIT_POLICY;
  if (!raw) return structuredClone(DEFAULT_MARKETPLACE_WRITE_POLICIES);
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: MarketplaceWritePolicies = structuredClone(DEFAULT_MARKETPLACE_WRITE_POLICIES);
    for (const operation of ['publish', 'revision', 'like', 'report'] as const) {
      const value = parsed[operation] as Record<string, unknown> | undefined;
      if (value === undefined) continue;
      const member = bucket(value?.member);
      const network = bucket(value?.network);
      if (!member || !network) return structuredClone(DEFAULT_MARKETPLACE_WRITE_POLICIES);
      result[operation] = { member, network };
    }
    return result;
  } catch {
    return structuredClone(DEFAULT_MARKETPLACE_WRITE_POLICIES);
  }
}

function bucket(value: unknown): TokenBucketPolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  return typeof item.refillPerMinute === 'number' && Number.isFinite(item.refillPerMinute)
    && item.refillPerMinute > 0 && typeof item.burst === 'number'
    && Number.isInteger(item.burst) && item.burst > 0
    ? { refillPerMinute: item.refillPerMinute, burst: item.burst }
    : null;
}
