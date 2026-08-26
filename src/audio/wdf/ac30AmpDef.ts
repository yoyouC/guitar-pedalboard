/**
 * WDF AC30 ⚗(Vox Top Boost 风格,英伦 chime)箱头定义。
 * 复制 amps.ts 中 wdfChampDef/wdfBognerDef 的接入模式,但音色栈在 worklet 内
 * (真实 top-boost 顺序:音色在 EL84 后级之前);MASTER 用原生 GainNode(dB 域)。
 * worklet 加载失败兜底直通。注册接线(AMP_REGISTRY / AudioEngine 预加载)由主代理收口。
 */
import type { EffectDefinition, EffectInstance } from '../effects/types';
import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from '../level';
import { WDF_4X_FIR_LATENCY } from '../latency';

// 默认位小信号链增益实测 −1.0dB(scripts/wdf-ac30-eval.ts L2),master 取 0dB → 接通≈旁通
const DEFAULTS = { gain: 30, bass: 50, mid: 55, treble: 60, presence: 55, master: 0 };
const TONE_KEYS = ['gain', 'bass', 'mid', 'treble', 'presence'] as const;

export function wdfAc30Def(): EffectDefinition {
  return {
    latency: WDF_4X_FIR_LATENCY,
    id: 'wdfac30',
    name: 'WDF AC30 ⚗',
    color: '#8c5a2b', // Vox 棕
    params: [
      { key: 'gain', label: 'GAIN', min: 0, max: 100, step: 1, defaultValue: DEFAULTS.gain },
      { key: 'bass', label: 'BASS', min: 0, max: 100, step: 1, defaultValue: DEFAULTS.bass },
      { key: 'mid', label: 'MID', min: 0, max: 100, step: 1, defaultValue: DEFAULTS.mid },
      { key: 'treble', label: 'TREBLE', min: 0, max: 100, step: 1, defaultValue: DEFAULTS.treble },
      { key: 'presence', label: 'PRESENCE', min: 0, max: 100, step: 1, defaultValue: DEFAULTS.presence },
      { key: 'master', label: 'MASTER', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: DEFAULTS.master, unit: 'dB' },
    ],
    create(ctx: AudioContext): EffectInstance {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const masterGain = ctx.createGain();
      masterGain.gain.value = levelDbToGain(DEFAULTS.master);

      let node: AudioWorkletNode | null = null;
      try {
        node = new AudioWorkletNode(ctx, 'wdf-ac30');
        input.connect(node);
        node.connect(masterGain);
        // 初始旋钮位 → worklet 参数(descriptor 默认之外的显式同步)
        for (const key of TONE_KEYS) {
          node.parameters.get(key)?.setValueAtTime(DEFAULTS[key], ctx.currentTime);
        }
      } catch (e) {
        console.warn('WDF AC30 worklet 未就绪,直通:', e);
        input.connect(masterGain);
      }
      masterGain.connect(output);

      return {
        input,
        output,
        update(key, value) {
          const t = ctx.currentTime;
          if (key === 'master') {
            masterGain.gain.setTargetAtTime(levelDbToGain(value), t, 0.03);
          } else {
            node?.parameters.get(key)?.setTargetAtTime(value, t, 0.03);
          }
        },
        dispose() {
          input.disconnect();
          node?.disconnect();
          masterGain.disconnect();
          output.disconnect();
        },
      };
    },
  };
}
