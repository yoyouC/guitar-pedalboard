## Parent

#1

## What to build

A single tone-stack module: a factory that builds the 4-band chain (input → bass lowshelf 120 Hz → mid peaking 700 Hz Q1 → treble highshelf 3200 Hz → presence highshelf 5000 Hz → output) and exposes an update function mapping the four tone params (percent → ±12 dB via `pctToDb`, presence ×8 as today). Before any adoption, pin tests record the exact frequencies, Q values, and param→gain mappings at every candidate call site — the five confirmed-identical sites adopt the module; the twin amp is adopted only if its mapping provably matches, otherwise it stays as-is with a comment documenting the deviation. Drive-gain and master-gain expressions at each site are explicitly out of the helper's scope and untouched.

## Acceptance criteria

- [ ] Pin tests (using the stub context) record the current frequencies, Q, and gain mappings for every candidate call site, including the twin amp — written against today's code and passing before any refactor
- [ ] The tone-stack factory exists and produces a graph identical to the pinned recordings at each adopting site
- [ ] Every call site whose pins match adopts the factory; any that don't are left untouched with a documenting comment
- [ ] Drive-gain and master-gain handling at each site is byte-for-byte equivalent after the refactor
- [ ] Existing 37 tests stay green; lint and build stay green

## Blocked by

- Stub AudioContext test harness
