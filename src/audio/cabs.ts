import type { EffectDefinition, EffectInstance } from './effects/types';
import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from './level';
import { CAB_IR_RUNTIME_DEF } from './cabIrRuntime';

const SMOOTH_SECONDS = 0.03;

interface CabModelConfig {
  hpHz: number;
  lowBumpFreq: number;
  lowBumpGainDb: number;
  peakFreq: number;
  peakGainDb: number;
  peakQ: number;
  lpHz: number;
  defaultLevelDb: number;
}

const CAB_MODELS: Record<string, CabModelConfig> = {
  open1x12: {
    hpHz: 100, lowBumpFreq: 120, lowBumpGainDb: 1.5,
    peakFreq: 3500, peakGainDb: 2, peakQ: 1.2, lpHz: 6000, defaultLevelDb: -1,
  },
  blue2x12: {
    hpHz: 85, lowBumpFreq: 110, lowBumpGainDb: 2,
    peakFreq: 3200, peakGainDb: 3, peakQ: 1.3, lpHz: 5500, defaultLevelDb: -1.5,
  },
  gb4x12: {
    hpHz: 75, lowBumpFreq: 100, lowBumpGainDb: 3,
    peakFreq: 2800, peakGainDb: 4, peakQ: 1.2, lpHz: 5000, defaultLevelDb: -2,
  },
  v304x12: {
    hpHz: 80, lowBumpFreq: 90, lowBumpGainDb: 2,
    peakFreq: 2400, peakGainDb: 5, peakQ: 1.5, lpHz: 4800, defaultLevelDb: -2,
  },
};

/** 原有的高通 → 低频峰值 → presence 峰值 → 双低通箱体配方。 */
function createCab(ctx: AudioContext, config: CabModelConfig): EffectInstance {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = config.hpHz;
  const lowBump = ctx.createBiquadFilter();
  lowBump.type = 'peaking';
  lowBump.frequency.value = config.lowBumpFreq;
  lowBump.Q.value = 1;
  lowBump.gain.value = config.lowBumpGainDb;
  const peak = ctx.createBiquadFilter();
  peak.type = 'peaking';
  peak.frequency.value = config.peakFreq;
  peak.Q.value = config.peakQ;
  peak.gain.value = config.peakGainDb;
  const lp1 = ctx.createBiquadFilter();
  lp1.type = 'lowpass';
  lp1.frequency.value = config.lpHz;
  const lp2 = ctx.createBiquadFilter();
  lp2.type = 'lowpass';
  lp2.frequency.value = config.lpHz;
  const chain: AudioNode[] = [input, hp, lowBump, peak, lp1, lp2, output];
  for (let index = 0; index < chain.length - 1; index++) chain[index].connect(chain[index + 1]);
  output.gain.value = levelDbToGain(config.defaultLevelDb);
  return {
    input,
    output,
    update(key, value) {
      if (key === 'level') {
        output.gain.setTargetAtTime(levelDbToGain(value), ctx.currentTime, SMOOTH_SECONDS);
      }
    },
    dispose() {
      for (const node of chain) node.disconnect();
    },
  };
}

function makeBuiltinCabDef(id: string, name: string, color: string): EffectDefinition {
  const config = CAB_MODELS[id];
  return {
    id,
    name,
    color,
    params: [{
      key: 'level', label: 'LEVEL', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX,
      step: 0.5, defaultValue: config.defaultLevelDb, unit: 'dB',
    }],
    create: (ctx) => createCab(ctx, config),
  };
}

const BUILTIN_CAB_REGISTRY: EffectDefinition[] = [
  makeBuiltinCabDef('open1x12', '1x12 Open', '#8a8f98'),
  makeBuiltinCabDef('blue2x12', '2x12 Blue', '#b03a2e'),
  makeBuiltinCabDef('gb4x12', '4x12 Greenback', '#c8a24a'),
  makeBuiltinCabDef('v304x12', '4x12 V30', '#5d6d7e'),
];

const customIrCab: EffectDefinition = {
  ...CAB_IR_RUNTIME_DEF,
  id: 'customIr',
  name: 'Custom IR',
  color: '#7467a8',
};

/** 四个 DSP 箱体 + 一个自定义卷积 IR 入口。 */
export const CAB_REGISTRY: EffectDefinition[] = [...BUILTIN_CAB_REGISTRY, customIrCab];
export const CAB_SELECTOR_REGISTRY = CAB_REGISTRY;

export function getCabDef(id: string): EffectDefinition {
  const def = CAB_REGISTRY.find((candidate) => candidate.id === id);
  if (!def) throw new Error(`未知箱体型号: ${id}`);
  return def;
}
