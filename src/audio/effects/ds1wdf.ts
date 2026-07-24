import type { EffectDefinition, EffectInstance } from './types';
import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from '../level';

/**
 * DS-1 WDF ⚗:与内置 distortion(WaveShaper 近似)并存的 WDF 精确电路建模版
 * (Boss DS-1:BJT 前级 → 运放可变增益 → 1N4148 对地削波 → LP/HP 交叉淡化 TONE)。
 * worklet 实现,加载失败兜底直通。
 */
export const ds1WdfEffect: EffectDefinition = {
  id: 'ds1wdf',
  name: 'DS-1 WDF ⚗',
  color: '#d97218',
  params: [
    { key: 'dist', label: 'DIST', min: 0, max: 100, step: 1, defaultValue: 50 },
    { key: 'tone', label: 'TONE', min: 0, max: 100, step: 1, defaultValue: 50 },
    { key: 'level', label: 'LEVEL', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: 0, unit: 'dB' },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();
    let node: AudioWorkletNode | null = null;
    try {
      node = new AudioWorkletNode(ctx, 'wdf-ds1');
      input.connect(node);
      node.connect(output);
    } catch (e) {
      console.warn('DS-1 WDF worklet 未就绪,直通:', e);
      input.connect(output);
    }
    // 内部电平归一化:DS-1 的 TONE 中位凹陷使输出偏弱,×2.5 补偿到同级响度
    // (只影响表现层响度,不改变 worklet 内已验证的非线性行为)
    output.gain.value = 2.5;
    node?.parameters.get('level')?.setValueAtTime(1, ctx.currentTime);
    return {
      input,
      output,
      update(key, value) {
        const t = ctx.currentTime;
        if (key === 'level') {
          node?.parameters.get('level')?.setTargetAtTime(levelDbToGain(value), t, 0.03);
        } else {
          node?.parameters.get(key)?.setTargetAtTime(value, t, 0.03);
        }
      },
      dispose() {
        input.disconnect();
        node?.disconnect();
        output.disconnect();
      },
    };
  },
};
