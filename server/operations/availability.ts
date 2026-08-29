export const MARKETPLACE_AVAILABILITY_POLICY = {
  version: 1,
  target: 0.995,
  routePrefix: '/api/marketplace/',
  syntheticPath: '/api/marketplace/health',
  syntheticIntervalMinutes: 5,
} as const;

export interface MarketplaceAvailabilityObservation {
  id: string;
  environment: 'production' | 'preview';
  source: 'request' | 'synthetic';
  path: string;
  status: number;
  observedAt: string;
}

export function evaluateMarketplaceAvailability(input: {
  start: Date;
  end: Date;
  observations: readonly MarketplaceAvailabilityObservation[];
}) {
  if (!(input.start < input.end)) throw new Error('Availability window must have a positive duration');
  const seen = new Set<string>();
  const eligible = input.observations.filter((observation) => {
    const time = Date.parse(observation.observedAt);
    const inScope = observation.environment === 'production'
      && observation.path.startsWith(MARKETPLACE_AVAILABILITY_POLICY.routePrefix)
      && !observation.path.includes('tone3000')
      && time >= input.start.getTime()
      && time < input.end.getTime();
    if (!inScope || seen.has(observation.id)) return false;
    seen.add(observation.id);
    return true;
  });
  const requests = eligible.filter((observation) => observation.source === 'request');
  const probes = eligible.filter((observation) => (
    observation.source === 'synthetic'
    && observation.path === MARKETPLACE_AVAILABILITY_POLICY.syntheticPath
  ));
  const expectedProbeSlots = Math.ceil(
    (input.end.getTime() - input.start.getTime())
      / (MARKETPLACE_AVAILABILITY_POLICY.syntheticIntervalMinutes * 60_000),
  );
  const probeSlots = new Map<number, boolean>();
  for (const probe of probes) {
    const slot = Math.floor(
      (Date.parse(probe.observedAt) - input.start.getTime())
        / (MARKETPLACE_AVAILABILITY_POLICY.syntheticIntervalMinutes * 60_000),
    );
    const healthy = probe.status >= 200 && probe.status < 300;
    probeSlots.set(slot, (probeSlots.get(slot) ?? true) && healthy);
  }
  const observedProbeSlots = probeSlots.size;
  const goodRequests = requests.filter((observation) => observation.status >= 100 && observation.status < 500).length;
  const goodProbes = [...probeSlots.values()].filter(Boolean).length;
  const denominator = requests.length + expectedProbeSlots;
  const numerator = goodRequests + goodProbes;
  const availability = denominator === 0 ? 0 : numerator / denominator;
  return {
    policy: MARKETPLACE_AVAILABILITY_POLICY,
    window: { start: input.start.toISOString(), end: input.end.toISOString() },
    requests: { good: goodRequests, total: requests.length },
    synthetic: { good: goodProbes, observedSlots: observedProbeSlots, expectedSlots: expectedProbeSlots },
    availability,
    passed: availability >= MARKETPLACE_AVAILABILITY_POLICY.target
      && observedProbeSlots === expectedProbeSlots,
  };
}
