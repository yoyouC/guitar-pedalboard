## Problem Statement

As the maintainer of this pedalboard, adding or changing a DSP effect means editing the same logic in many places: worklet-loading boilerplate is copied across 25 modules (with a latent multi-context bug), 19 effect wrappers are near-identical pass-throughs differing only in data, and the 4-band amp tone stack is hand-copied into at least 5 amp definitions. Each copy must be edited in lockstep; missing one produces silent audio degradation (the worklet fallback is passthrough-by-design, so failures don't surface). There is no audio test coverage, so refactors here are currently unscary only because nobody dares do them.

## Solution

Three behaviour-preserving structural refactors, each pinned by new characterisation tests run against a stub AudioContext:

1. A single worklet-loader module behind a `load(ctx)` function, replacing all 25 copied loader tails, with per-context (WeakSet) registration semantics.
2. A data-driven factory that turns each of the 19 pass-through worklet effects into a declarative spec, preserving ids, parameter tables, fallback behaviour, and the two dispose variants.
3. A single tone-stack module hiding the 4-band filter chain and its param→gain mapping, adopted by every amp definition whose mapping it provably matches.

From the user's perspective: nothing changes. Same pedals, same sounds, same defaults. The only user-visible evidence is that the app still works identically.

## User Stories

1. As the maintainer, I want one place to edit worklet-loading logic, so that a fix applies to all 25 worklets at once.
2. As the maintainer, I want worklet registration to be per-AudioContext, so that a recreated context can't silently lose all DSP.
3. As the maintainer, I want each worklet effect defined as data, so that adding a new wrapped worklet is a config entry, not a new file of boilerplate.
4. As the maintainer, I want the tone stack defined once, so that a voicing change (e.g. presence range) can't drift between amp models.
5. As the maintainer, I want characterisation tests pinning today's registry, param mappings, and loader behaviour, so that this refactor — and every future one — has a safety net.
6. As a future agent working in this repo, I want the tests to run in Node without a browser, so that CI/agent loops can verify audio-structure changes.
7. As a pedalboard user, I want zero change in sound, defaults, or pedal behaviour, so that the refactor is invisible to me.
8. As the maintainer, I want each refactor as a separate commit on one branch, so that any regression bisects cleanly.
9. As the maintainer, I want the one deliberate deviation (per-context loader semantics) recorded as an ADR, so that future readers know it was intentional.

## Implementation Decisions

- **Loader helper (#4)**: a factory taking the processor source string and returning an idempotent `load(ctx)`; registration state is a `WeakSet<AudioContext>` (the semantics the looper worklet loader already uses). This is the one deliberate deviation from current behaviour — module-global flags are replaced; under the current singleton engine this is behaviour-identical. All 25 existing loaders (21 WDF, wah, whammy, noise gate; the NAM loader keeps its fetch+shim variant) are re-expressed through the helper. The AudioEngine init sequence keeps its exact ordering and warn-and-degrade error handling.
- **Effect factory (#5)**: a factory taking a declarative spec (id, name, color, param table, processor name, dispose variant flag) and returning an `EffectDefinition`. Each of the 19 existing effect modules shrinks to a data literal; the registry's shape, order, and contents are unchanged. The two existing dispose variants (with and without the `suspend` message) are preserved as a factory flag. The `'bbd-analog-delay'` processor-name outlier is preserved verbatim, not "fixed".
- **Tone stack (#6)**: a module exporting a factory that builds the 4-band chain (input → bass → mid → treble → presence → output) and exposes an update function for its four params. The five confirmed-identical call sites adopt it; the twin amp's mapping will be pinned by test first, and adopted only if it matches, otherwise left in place and documented.
- **NAM tone stack** is included in #6's adoption set only where its mapping (including the drive-gain `Math.pow(10, …/20)` expression, which is *not* part of the tone stack) is unaffected — the helper covers bass/mid/treble/presence only.
- **Test harness**: a stub AudioContext/AudioNode/AudioParam/AudioWorkletNode test double that records graph structure and param calls; shared by all three tickets. It asserts behaviour through the `EffectDefinition` interface — never against internal file structure.
- **Branch/commits**: one branch `refactor/worklet-dedup`, one commit per ticket, code-review before each commit.

## Testing Decisions

- Good tests here assert **external behaviour through the EffectDefinition interface**: given a stub context, `create()` produces the same node graph and `update()` produces the same param calls as before the refactor. No test reaches past the interface into module internals.
- **Modules tested**: the loader helper (idempotency, per-context re-registration, failure propagation); the effect factory (registry snapshot — ids, names, param tables, defaults — unchanged; create/update/dispose behaviour per variant); the tone stack (frequency/Q values and param→gain mappings, incl. ±12 dB range and presence ×8, at every adopting call site).
- **Prior art**: `tests/preset-codec.test.ts` (table-driven domain pinning), `tests/midi-mapping.test.ts` (pure-function mapping tables). The stub-context pattern is new but follows the existing `tsx --test` Node runner — no new test framework.
- Baseline before any change: 37 existing tests green, lint clean, `vite build` green — re-verified after each ticket.

## Out of Scope

- No changes to WDF DSP internals, worklet processor source strings, or the dual-implementation drift (that's a separate future effort).
- No changes to `AudioEngine` structure, `App.tsx`, components, state, or MIDI layers.
- No sonic changes: no retuning, no new effects, no fallback-behaviour changes beyond the per-context loader semantics.
- No new runtime dependencies; no build/tooling changes.
- Collapsing the 19 effect data files into one module — deferred until the data literals prove stable.

## Further Notes

- Origin: codebase survey (deepening opportunities #4–#6), run 2026-08-12.
- The twin-amp tone-stack question resolves itself during #6's pin tests: match → adopt; mismatch → leave and document.
- The per-context loader deviation will be recorded as an ADR under `docs/adr/` when the loader ticket lands.
