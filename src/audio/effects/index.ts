import type { EffectDefinition } from './types';
import { noiseGateEffect } from './noiseGate';
import { compressorEffect } from './compressor';
import { overdriveEffect } from './overdrive';
import { ts808Effect } from './ts808';
import { ts808WdfEffect } from './ts808wdf';
import { ratWdfEffect } from './ratwdf';
import { klonWdfEffect } from './klonwdf';
import { ds1WdfEffect } from './ds1wdf';
import { fuzzfaceWdfEffect } from './fuzzfacewdf';
import { bigmuffWdfEffect } from './bigmuffwdf';
import { klonEffect } from './klon';
import { distortionEffect } from './distortion';
import { ratEffect } from './rat';
import { fuzzEffect } from './fuzz';
import { autowahEffect } from './autowah';
import { eqEffect } from './eq';
import { chorusEffect } from './chorus';
import { flangerEffect } from './flanger';
import { phaserEffect } from './phaser';
import { tremoloEffect } from './tremolo';
import { delayEffect } from './delay';
import { reverbEffect } from './reverb';
import { volumeEffect } from './volume';
import { NAM_PEDAL_EFFECTS } from './namPedal';

/** 效果器目录,按吉他信号链常见顺序排列 */
export const EFFECT_REGISTRY: EffectDefinition[] = [
  noiseGateEffect,
  compressorEffect,
  klonEffect,
  overdriveEffect,
  ts808Effect,
  ts808WdfEffect,
  klonWdfEffect,
  ratWdfEffect,
  ds1WdfEffect,
  fuzzfaceWdfEffect,
  bigmuffWdfEffect,
  distortionEffect,
  ratEffect,
  fuzzEffect,
  autowahEffect,
  eqEffect,
  chorusEffect,
  flangerEffect,
  phaserEffect,
  tremoloEffect,
  delayEffect,
  reverbEffect,
  volumeEffect,
  // NAMKnobs 条件化单块(见 namPedal.ts)
  ...NAM_PEDAL_EFFECTS,
];

export function getEffectDef(id: string): EffectDefinition {
  const def = EFFECT_REGISTRY.find((d) => d.id === id);
  if (!def) throw new Error(`未知效果器类型: ${id}`);
  return def;
}
