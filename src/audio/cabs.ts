import type { EffectDefinition, EffectInstance } from './effects/types';
import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from './level';

const SMOOTH = 0.03;

/** 箱体频响配方:高通 + 低频共振 + 临场峰 + 双级低通(24dB/oct) */
interface CabModelConfig {
  hpHz: number;
  lowBumpFreq: number;
  lowBumpGainDb: number;
  peakFreq: number;
  peakGainDb: number;
  peakQ: number;
  lpHz: number;
  defaults: { level: number };
}

const CAB_MODELS: Record<string, CabModelConfig> = {
  open1x12: {
    // 1x12 开背:低频量少、通透(开放式后背的低频抵消)
    hpHz: 100,
    lowBumpFreq: 120,
    lowBumpGainDb: 1.5,
    peakFreq: 3500,
    peakGainDb: 2,
    peakQ: 1.2,
    lpHz: 6000,
    defaults: { level: -1 },
  },
  blue2x12: {
    // 2x12 Celestion Blue(Vox 类):中高频“钟声”、温润
    hpHz: 85,
    lowBumpFreq: 110,
    lowBumpGainDb: 2,
    peakFreq: 3200,
    peakGainDb: 3,
    peakQ: 1.3,
    lpHz: 5500,
    defaults: { level: -1.5 },
  },
  gb4x12: {
    // 4x12 Greenback(Marshall 1960):低频共振厚、2.8k 临场峰
    hpHz: 75,
    lowBumpFreq: 100,
    lowBumpGainDb: 3,
    peakFreq: 2800,
    peakGainDb: 4,
    peakQ: 1.2,
    lpHz: 5000,
    defaults: { level: -2 },
  },
  v304x12: {
    // 4x12 Vintage 30:攻击性上中频尖峰、现代高增益标配
    hpHz: 80,
    lowBumpFreq: 90,
    lowBumpGainDb: 2,
    peakFreq: 2400,
    peakGainDb: 5,
    peakQ: 1.5,
    lpHz: 4800,
    defaults: { level: -2 },
  },
};

function createCab(ctx: AudioContext, cfg: CabModelConfig): EffectInstance {
  const input = ctx.createGain();
  const output = ctx.createGain();

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = cfg.hpHz;
  const lowBump = ctx.createBiquadFilter();
  lowBump.type = 'peaking';
  lowBump.frequency.value = cfg.lowBumpFreq;
  lowBump.Q.value = 1;
  lowBump.gain.value = cfg.lowBumpGainDb;
  const peak = ctx.createBiquadFilter();
  peak.type = 'peaking';
  peak.frequency.value = cfg.peakFreq;
  peak.Q.value = cfg.peakQ;
  peak.gain.value = cfg.peakGainDb;
  const lp1 = ctx.createBiquadFilter();
  lp1.type = 'lowpass';
  lp1.frequency.value = cfg.lpHz;
  const lp2 = ctx.createBiquadFilter();
  lp2.type = 'lowpass';
  lp2.frequency.value = cfg.lpHz;

  const chain: AudioNode[] = [input, hp, lowBump, peak, lp1, lp2, output];
  for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);

  output.gain.value = levelDbToGain(cfg.defaults.level);

  return {
    input,
    output,
    update(key, value) {
      if (key === 'level') {
        output.gain.setTargetAtTime(levelDbToGain(value), ctx.currentTime, SMOOTH);
      }
    },
    dispose() {
      chain.forEach((n) => n.disconnect());
    },
  };
}

function makeCabDef(id: string, name: string, color: string): EffectDefinition {
  const cfg = CAB_MODELS[id];
  return {
    id,
    name,
    color,
    params: [
      { key: 'level', label: 'LEVEL', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: cfg.defaults.level, unit: 'dB' },
    ],
    create: (ctx) => createCab(ctx, cfg),
  };
}

/** 箱体目录(复用效果器接口) */
export const CAB_REGISTRY: EffectDefinition[] = [
  makeCabDef('open1x12', '1x12 Open', '#8a8f98'),
  makeCabDef('blue2x12', '2x12 Blue', '#b03a2e'),
  makeCabDef('gb4x12', '4x12 Greenback', '#c8a24a'),
  makeCabDef('v304x12', '4x12 V30', '#5d6d7e'),
];

export function getCabDef(id: string): EffectDefinition {
  const def = CAB_REGISTRY.find((d) => d.id === id);
  if (!def) throw new Error(`未知箱体型号: ${id}`);
  return def;
}
