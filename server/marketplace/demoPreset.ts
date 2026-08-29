import type { CanonicalPublishedPreset } from '../../shared/marketplace.ts';

export const DEMO_PUBLISHED_PRESET_ID = 'preset-demo-crunch';

export const demoPublishedPreset: CanonicalPublishedPreset = {
  id: DEMO_PUBLISHED_PRESET_ID,
  title: 'Demo Crunch',
  description: 'A reproducible built-in crunch Rig.',
  visibility: 'public',
  creator: {
    id: 'member-system',
    handle: 'guitar-pedalboard',
    displayName: 'Guitar Pedalboard',
  },
  tags: [{
    id: 'tone-crunch',
    dimension: 'tone',
    nameZh: 'Crunch',
    nameEn: 'Crunch',
  }],
  derivedAttributes: {
    pedalIds: [],
    ampId: 'crunch',
    ampModelKey: 'builtin:crunch',
    cabId: 'gb4x12',
    resourceKinds: ['builtin'],
  },
  currentRevision: {
    payloadKind: 'canonical-rig',
    id: 'revision-demo-crunch-1',
    schemaVersion: 5,
    createdAt: '2026-08-29T00:00:00.000Z',
    resourceDependencies: [{ kind: 'builtin' }],
    derivedAttributes: {
      pedalIds: [],
      ampId: 'crunch',
      ampModelKey: 'builtin:crunch',
      cabId: 'gb4x12',
      resourceKinds: ['builtin'],
    },
    rig: {
      chain: [],
      amp: {
        categoryId: 'crunch',
        modelKey: 'builtin:crunch',
        enabled: true,
        values: {
          gain: 60,
          bass: 50,
          mid: 65,
          treble: 60,
          presence: 55,
          master: -20.5,
        },
        customName: null,
      },
      cab: {
        id: 'gb4x12',
        ir: { kind: 'builtin', id: 'gb4x12' },
        enabled: true,
        values: { level: -2 },
      },
      preAmpEq: {
        enabled: false,
        bands: {
          hz31_25: 0,
          hz62_5: 0,
          hz125: 0,
          hz250: 0,
          hz500: 0,
          hz1000: 0,
          hz2000: 0,
          hz4000: 0,
          hz8000: 0,
          hz16000: 0,
        },
        levelDb: 0,
      },
      globals: { inputGain: 1, masterVolume: 0.5, bypass: false },
    },
  },
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
};
