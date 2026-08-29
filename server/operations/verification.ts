export type MarketplaceBenchmarkOperation = 'list' | 'detail' | 'search' | 'revision';

export interface MarketplaceOperationalReportInput {
  dataset: { members: number; publicPresets: number };
  durationsMs: Record<MarketplaceBenchmarkOperation, readonly number[]>;
  searchConvergenceMs: number;
}

export interface MarketplaceOperationalFailure {
  metric: string;
  actual: number;
  target: number;
}

export const MARKETPLACE_OPERATIONAL_TARGETS = {
  readP95Ms: 500,
  revisionP95Ms: 2_000,
  searchConvergenceMs: 60_000,
} as const;

export function nearestRankPercentile(values: readonly number[], percentile: number): number {
  if (values.length === 0) throw new Error('At least one sample is required');
  if (!(percentile > 0 && percentile <= 100)) throw new Error('Percentile must be in (0, 100]');
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile / 100 * sorted.length) - 1];
}

export function evaluateMarketplaceOperationalReport(input: MarketplaceOperationalReportInput) {
  const p95 = Object.fromEntries(
    Object.entries(input.durationsMs).map(([operation, values]) => (
      [operation, nearestRankPercentile(values, 95)]
    )),
  ) as Record<MarketplaceBenchmarkOperation, number>;
  const failures: MarketplaceOperationalFailure[] = [];
  const requireAtLeast = (metric: string, actual: number, target: number) => {
    if (actual < target) failures.push({ metric, actual, target });
  };
  const requireAtMost = (metric: string, actual: number, target: number) => {
    if (actual > target) failures.push({ metric, actual, target });
  };
  requireAtLeast('dataset.members', input.dataset.members, 10_000);
  requireAtLeast('dataset.publicPresets', input.dataset.publicPresets, 100_000);
  for (const operation of ['list', 'detail', 'search'] as const) {
    requireAtMost(`latency.${operation}.p95`, p95[operation], MARKETPLACE_OPERATIONAL_TARGETS.readP95Ms);
  }
  requireAtMost('latency.revision.p95', p95.revision, MARKETPLACE_OPERATIONAL_TARGETS.revisionP95Ms);
  requireAtMost(
    'search.convergence', input.searchConvergenceMs,
    MARKETPLACE_OPERATIONAL_TARGETS.searchConvergenceMs,
  );
  return {
    passed: failures.length === 0,
    dataset: input.dataset,
    samples: Object.fromEntries(Object.entries(input.durationsMs).map(([key, values]) => (
      [key, values.length]
    ))),
    p95Ms: p95,
    searchConvergenceMs: input.searchConvergenceMs,
    targets: MARKETPLACE_OPERATIONAL_TARGETS,
    failures,
  };
}
