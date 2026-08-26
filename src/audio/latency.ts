import type { EffectDefinition, EffectLatency } from './effects/types';
import type { AmpSpec, ChainSpec, GraphSpec } from './graphBuilder';

export interface LatencyBreakdownItem {
  id: string;
  name: string;
  processingSamples: number;
  designSamples: number;
}

export interface RigLatency {
  sampleRate: number;
  processingSamples: number;
  designSamples: number;
  processingMs: number;
  designMs: number;
  totalMs: number;
  items: LatencyBreakdownItem[];
}

const ZERO_LATENCY: EffectLatency = { processingSamples: 0, designSamples: 0 };

function resolveLatency(
  def: EffectDefinition,
  values: Record<string, number>,
  sampleRate: number,
): EffectLatency {
  const latency = typeof def.latency === 'function' ? def.latency(values, sampleRate) : def.latency;
  if (!latency) return ZERO_LATENCY;
  return {
    processingSamples: Math.max(0, Math.round(latency.processingSamples)),
    designSamples: Math.max(0, Math.round(latency.designSamples)),
  };
}

function active(spec: AmpSpec | null): spec is AmpSpec {
  return spec !== null && spec.enabled;
}

/**
 * 当前 Rig 的直接监听路径时延。模块内部的干湿并联由 definition 自己报告
 * 最早直接声/主路径，不在这里把音乐性 delay time 简单相加。
 */
export function calculateRigLatency(spec: GraphSpec, sampleRate: number): RigLatency {
  if (spec.globalBypass) {
    return {
      sampleRate,
      processingSamples: 0,
      designSamples: 0,
      processingMs: 0,
      designMs: 0,
      totalMs: 0,
      items: [],
    };
  }

  const orderedChain = [
    ...spec.chain.filter((item) => item.enabled && !item.post),
    ...spec.chain.filter((item) => item.enabled && item.post),
  ];
  const modules: Array<{ id: string; def: EffectDefinition; values: Record<string, number> }> =
    orderedChain.map((item: ChainSpec) => ({ id: item.uid, def: item.def, values: item.values }));
  if (active(spec.amp)) modules.push({ id: `amp:${spec.amp.def.id}`, def: spec.amp.def, values: spec.amp.values });
  if (active(spec.cab)) modules.push({ id: `cab:${spec.cab.def.id}`, def: spec.cab.def, values: spec.cab.values });

  const items = modules
    .map(({ id, def, values }) => ({ id, name: def.name, ...resolveLatency(def, values, sampleRate) }))
    .filter((item) => item.processingSamples > 0 || item.designSamples > 0);
  const processingSamples = items.reduce((sum, item) => sum + item.processingSamples, 0);
  const designSamples = items.reduce((sum, item) => sum + item.designSamples, 0);
  const samplesToMs = (samples: number) => (samples / sampleRate) * 1000;
  return {
    sampleRate,
    processingSamples,
    designSamples,
    processingMs: samplesToMs(processingSamples),
    designMs: samplesToMs(designSamples),
    totalMs: samplesToMs(processingSamples + designSamples),
    items,
  };
}

/** 4x 上/下采样两枚 48-tap 线性相位 FIR 的合计群延迟，约 11.75 基率 samples。 */
export const WDF_4X_FIR_LATENCY: EffectLatency = {
  processingSamples: 12,
  designSamples: 0,
};
