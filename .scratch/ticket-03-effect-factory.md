## Parent

#1

## What to build

A factory that turns a declarative spec (id, name, color, parameter table, processor name, dispose-variant flag) into an `EffectDefinition`. Each of the 19 pass-through worklet-effect modules shrinks from ~45 lines of near-identical code to a ~15-line data literal. The effect registry's contents, order, and shape are provably unchanged: same ids, names, defaults, and parameter ranges. The two existing dispose variants (with and without the suspend message) are preserved as a factory flag, the worklet-construction failure still falls back to passthrough, and the `'bbd-analog-delay'` processor-name outlier is preserved verbatim.

## Acceptance criteria

- [ ] The factory exists and all 19 pass-through worklet effects are defined through it as data literals
- [ ] A registry snapshot test pins every effect's id, name, and full parameter table (keys, min, max, defaults) to today's values
- [ ] Pin tests (using the stub context) prove per effect: `create()` wires input → worklet node → output; `update(key, value)` reaches the named AudioParam; construction failure falls back to passthrough; each dispose variant behaves as today
- [ ] No effect's processor name changes, including the `bbd-analog-delay` outlier
- [ ] Existing 37 tests stay green; lint and build stay green

## Blocked by

- Stub AudioContext test harness
- Worklet-loader helper with per-context semantics
