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
import { crybabyWdfEffect } from './crybabywdf';
import { wahpedalEffect } from './wahpedal';
import { eqEffect } from './eq';
import { chorusEffect } from './chorus';
import { flangerEffect } from './flanger';
import { phaserEffect } from './phaser';
import { tremoloEffect } from './tremolo';
import { delayEffect } from './delay';
import { reverbEffect } from './reverb';
import { springReverbEffect } from './springreverb';
import { plateEffect } from './plate';
import { shimmerEffect } from './shimmer';
import { analogDelayEffect } from './analogdelay';
import { tapeDelayEffect } from './tapedelay';
import { pingpongEffect } from './pingpong';
import { la2aEffect } from './la2a';
import { fet1176Effect } from './fet1176';
import { dynaCompEffect } from './dynacomp';
import { volumeEffect } from './volume';
import { whammyEffect } from './whammy';
import { NAM_PEDAL_EFFECTS } from './namPedal';

/** 效果器目录,按吉他信号链常见顺序排列 */
export const EFFECT_REGISTRY: EffectDefinition[] = [
  noiseGateEffect,
  whammyEffect,
  compressorEffect,
  la2aEffect,
  fet1176Effect,
  dynaCompEffect,
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
  crybabyWdfEffect,
  wahpedalEffect,
  eqEffect,
  chorusEffect,
  flangerEffect,
  phaserEffect,
  tremoloEffect,
  delayEffect,
  analogDelayEffect,
  tapeDelayEffect,
  pingpongEffect,
  reverbEffect,
  springReverbEffect,
  plateEffect,
  shimmerEffect,
  volumeEffect,
  // NAMKnobs 条件化单块(见 namPedal.ts)
  ...NAM_PEDAL_EFFECTS,
];

export function getEffectDef(id: string): EffectDefinition {
  const def = EFFECT_REGISTRY.find((d) => d.id === id);
  if (!def) throw new Error(`未知效果器类型: ${id}`);
  return def;
}
