import type { EffectDefinition, EffectInstance } from './types';
import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from '../level';

const SMOOTH = 0.03;

/**
 * Whammy 移调踏板:调制延迟线移调(见 whammyWorklet.ts),摇杆从 0 扫到
 * RANGE 指定的音程(±1/±2 半音,向下为负)。TREADLE 由摇杆驱动
 * (a-rate 逐样本),后续可接 MIDI CC。worklet 未加载时兜底直通。
 */
export const whammyEffect: EffectDefinition = {
  id: 'whammy',
  name: 'Whammy',
  color: '#c0392b',
  params: [
    { key: 'position', label: 'TREADLE', min: 0, max: 100, step: 1, defaultValue: 0, unit: '%' },
    { key: 'range', label: 'RANGE', min: -2, max: 2, step: 1, defaultValue: 2, unit: 'st' },
    { key: 'level', label: 'LEVEL', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: 0, unit: 'dB' },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();
    let node: AudioWorkletNode | null = null;
    try {
      node = new AudioWorkletNode(ctx, 'whammy-shift');
      input.connect(node);
      node.connect(output);
    } catch (e) {
      console.warn('Whammy worklet 未就绪,直通:', e);
      input.connect(output);
    }
    node?.parameters.get('level')?.setValueAtTime(1, ctx.currentTime);

    // semitones = position/100 × range,两个参数共同决定,需各自缓存
    let position = 0;
    let range = 2;
    const applyShift = (): void => {
      const st = (position / 100) * range;
      node?.parameters.get('semitones')?.setTargetAtTime(st, ctx.currentTime, SMOOTH);
    };

    return {
      input,
      output,
      update(key, value) {
        const t = ctx.currentTime;
        switch (key) {
          case 'position':
            position = value;
            applyShift();
            break;
          case 'range':
            range = value;
            applyShift();
            break;
          case 'level':
            node?.parameters.get('level')?.setTargetAtTime(levelDbToGain(value), t, SMOOTH);
            break;
        }
      },
      dispose() {
        input.disconnect();
        output.disconnect();
        if (node) {
          // 通知处理器停止渲染(返回 false),防止僵尸 worklet 空转音频线程
          try {
            node.port.postMessage({ type: 'suspend' });
            node.port.onmessage = null;
          } catch {
            /* 端口已关闭 */
          }
          node.disconnect();
          node = null;
        }
      },
    };
  },
};
