export interface MarketplaceTrendingPolicy {
  windowHours: number;
  halfLifeHours: number;
}

export const DEFAULT_MARKETPLACE_TRENDING_POLICY: MarketplaceTrendingPolicy = Object.freeze({
  windowHours: 24 * 7,
  halfLifeHours: 48,
});

export function parseMarketplaceTrendingPolicy(
  environment: Record<string, string | undefined>,
): MarketplaceTrendingPolicy {
  return {
    windowHours: positiveInteger(
      environment.MARKETPLACE_TRENDING_WINDOW_HOURS,
      DEFAULT_MARKETPLACE_TRENDING_POLICY.windowHours,
      24 * 30,
    ),
    halfLifeHours: positiveInteger(
      environment.MARKETPLACE_TRENDING_HALF_LIFE_HOURS,
      DEFAULT_MARKETPLACE_TRENDING_POLICY.halfLifeHours,
      24 * 30,
    ),
  };
}

export function marketplaceTrendScore(
  likedAt: Date,
  now: Date,
  policy: MarketplaceTrendingPolicy,
): number {
  const ageHours = (now.getTime() - likedAt.getTime()) / 3_600_000;
  if (ageHours < 0 || ageHours > policy.windowHours) return 0;
  return 2 ** (-ageHours / policy.halfLifeHours);
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) return fallback;
  return parsed;
}
