## Parent

#1

## What to build

A single worklet-loader module: a factory that takes a processor source string and returns an idempotent `load(ctx)` function, with registration tracked per-AudioContext via `WeakSet` (the semantics the looper worklet loader already uses). All 25 copied loader tails (21 WDF worklets, wah, whammy, noise gate) are re-expressed through the helper; the NAM loader keeps its fetch+shim variant. The AudioEngine init sequence keeps its exact ordering and warn-and-degrade error handling. From the user's perspective nothing changes — the same worklets load in the same order, and a second AudioContext would now also get its worklets (today it silently wouldn't).

## Acceptance criteria

- [ ] One loader factory exists and every one of the 25 loader modules delegates to it
- [ ] Pin tests (using the stub context) prove: `load(ctx)` registers exactly once per context, registers again on a second context, and propagates failures
- [ ] The module-global `loaded` flags are gone; per-context registration is the only semantics
- [ ] Init ordering and per-loader warn-and-degrade behaviour in the engine are unchanged
- [ ] An ADR under `docs/adr/` records the deliberate per-context deviation from the old global-flag behaviour
- [ ] Existing 37 tests stay green; lint and build stay green

## Blocked by

- Stub AudioContext test harness
