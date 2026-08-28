# Legacy Cab DSP baseline

Captured before Issue #19 removes the production Biquad path. The source of truth remains the
versioned `CAB_MODELS` table and `createCab()` topology in `src/audio/cabs.ts`.

Topology for every model: high-pass → low-frequency peaking filter → presence peaking filter →
two identical low-pass stages → output level. Filters whose Q is not listed use the Web Audio
default Q; level smoothing uses a 30ms `setTargetAtTime` constant.

| Canonical id | HP Hz | Low bump Hz / dB | Presence Hz / dB / Q | LP Hz × stages | Default level dB |
|---|---:|---:|---:|---:|---:|
| `open1x12` | 100 | 120 / +1.5 | 3500 / +2 / 1.2 | 6000 × 2 | -1 |
| `blue2x12` | 85 | 110 / +2 | 3200 / +3 / 1.3 | 5500 × 2 | -1.5 |
| `gb4x12` | 75 | 100 / +3 | 2800 / +4 / 1.2 | 5000 × 2 | -2 |
| `v304x12` | 80 | 90 / +2 | 2400 / +5 / 1.5 | 4800 × 2 | -2 |

These values are compatibility/calibration references, not candidate IR assets. Final IR gains must
be listening-calibrated against these defaults and recorded in `public/irs/manifest.json`.

The accepted assets were also measured against this topology at 48 kHz using 1,024 linearly spaced
70 Hz–10 kHz frequency samples with pink-power (`1/f`) weighting. LEVEL is excluded from both sides,
because its legacy default and saved user values remain unchanged and are applied after asset
calibration.

| Canonical id | Legacy DSP weighted transfer | Raw IR weighted transfer | Asset calibration | Calibrated IR transfer |
|---|---:|---:|---:|---:|
| `open1x12` | +1.178 dB | +17.088 dB | -15.909 dB | +1.179 dB |
| `blue2x12` | +1.573 dB | +13.961 dB | -12.388 dB | +1.573 dB |
| `gb4x12` | +2.129 dB | +18.565 dB | -16.436 dB | +2.129 dB |
| `v304x12` | +1.980 dB | +15.356 dB | -13.376 dB | +1.980 dB |

`tests/cab-ir-assets.test.ts` pins each source hash, WAV metadata, raw peak/RMS, three response-envelope
points, calibrated broadband output, and a calibrated unit-impulse peak below 0.2. Fixed-DI blind
listening remains necessary because objective broadband matching cannot establish perceived tone.
