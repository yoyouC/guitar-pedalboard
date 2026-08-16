## Parent

#1

## What to build

A shared test double for the Web Audio API — stub AudioContext, AudioNode, AudioParam, AudioWorkletNode, and BiquadFilter/Gain/Analyser node types — that records graph structure (connections, node types) and parameter calls (`value` sets, `setTargetAtTime`). It plugs into the existing `tsx --test` runner with no new dependencies, and gives the refactor tickets a way to assert audio-graph behaviour through the `EffectDefinition` interface without a browser. Ships with one smoke test proving the double records correctly.

## Acceptance criteria

- [ ] Stub context can create every node type the effect/amp definitions use, and each stub node records its type, construction name (for worklet nodes), and parameter values
- [ ] Connections between stub nodes are recorded and assertable (who connected to whom)
- [ ] `AudioParam.value` assignments and `setTargetAtTime` calls are recorded with their arguments
- [ ] A smoke test constructs a small graph through the double and asserts on the recording
- [ ] No production code is modified; existing 37 tests stay green; lint and build stay green

## Blocked by

None — can start immediately
