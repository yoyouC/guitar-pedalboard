export type MarketplaceWriteOperation = 'publish' | 'revision' | 'like' | 'report';

export interface TokenBucketPolicy { refillPerMinute: number; burst: number }
export interface MarketplaceWritePolicy { member: TokenBucketPolicy; network: TokenBucketPolicy }
export type MarketplaceWritePolicies = Partial<Record<MarketplaceWriteOperation, MarketplaceWritePolicy>>;

export interface MarketplaceWriteLimiter {
  consume(input: {
    operation: MarketplaceWriteOperation;
    memberId: string;
    networkSource: string;
    now: Date;
  }): Promise<{ allowed: boolean; retryAt?: Date }>;
  purgeMember?(memberId: string): Promise<void>;
}

export function marketplaceNetworkSource(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')?.trim()
    || 'unknown';
}

export async function marketplaceWriteLimitDenied(input: {
  limiter?: MarketplaceWriteLimiter;
  operation: MarketplaceWriteOperation;
  memberId: string;
  request: Request;
  now: Date;
}): Promise<Response | null> {
  if (!input.limiter) return null;
  const result = await input.limiter.consume({
    operation: input.operation, memberId: input.memberId,
    networkSource: marketplaceNetworkSource(input.request), now: input.now,
  });
  if (result.allowed) return null;
  const defaultRetryAtMs = input.now.getTime() + 60_000;
  const candidateRetryAtMs = result.retryAt?.getTime() ?? defaultRetryAtMs;
  const maxRetryAtMs = input.now.getTime() + 30 * 24 * 60 * 60_000;
  const retryAt = new Date(
    Number.isFinite(candidateRetryAtMs)
      && candidateRetryAtMs > input.now.getTime()
      && candidateRetryAtMs <= maxRetryAtMs
      ? candidateRetryAtMs
      : defaultRetryAtMs,
  );
  const retryAfter = Math.max(1, Math.ceil((retryAt.getTime() - input.now.getTime()) / 1000));
  return Response.json({
    error: {
      code: 'write_rate_limited', message: 'Community write rate limit reached',
      operation: input.operation, retryAt: retryAt.toISOString(),
    },
  }, { status: 429, headers: { 'Retry-After': String(retryAfter) } });
}
