/**
 * WDF JC-120(Roland Jazz Chorus 风格,全固态极致清音)箱头定义。
 * 复制 wdfBognerDef 模式:worklet 负责 WDF 清音主链(GAIN/CHORUS 进 worklet),
 * 三段音色栈 / PRESENCE / MASTER 用原生节点;worklet 加载失败兜底直通。
 * 引擎启动时需调用 loadJc120Wdf(ctx) 预加载(见 AudioEngine 注册接线)。
 */
import type { EffectDefinition, EffectInstance } from '../effects/types';
import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from '../level';
import { createToneStack } from '../toneStack';

const DEFAULTS = { gain: 40, bass: 50, mid: 50, treble: 60, presence: 60, master: -6 };

export function wdfJc120Def(): EffectDefinition {
  return {
    id: 'wdfjc120',
    name: 'WDF JC-120 ⚗',
    color: '#a8b0b8',
    params: [
      { key: 'gain', label: 'GAIN', min: 0, max: 100, step: 1, defaultValue: DEFAULTS.gain },
      { key: 'bass', label: 'BASS', min: 0, max: 100, step: 1, defaultValue: DEFAULTS.bass },
      { key: 'mid', label: 'MID', min: 0, max: 100, step: 1, defaultValue: DEFAULTS.mid },
      { key: 'treble', label: 'TREBLE', min: 0, max: 100, step: 1, defaultValue: DEFAULTS.treble },
      { key: 'presence', label: 'PRESENCE', min: 0, max: 100, step: 1, defaultValue: DEFAULTS.presence },
      { key: 'master', label: 'MASTER', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: DEFAULTS.master, unit: 'dB' },
      { key: 'chorus', label: 'CHORUS', min: 0, max: 1, step: 1, defaultValue: 0 },
    ],
    create(ctx: AudioContext): EffectInstance {
      const input = ctx.createGain();
      const output = ctx.createGain();

      let node: AudioWorkletNode | null = null;
      // 音色栈(±12dB,共享模块,见 toneStack.ts)
      const tone = createToneStack(ctx, DEFAULTS);
      const masterGain = ctx.createGain();

      masterGain.gain.value = levelDbToGain(DEFAULTS.master);

      try {
        node = new AudioWorkletNode(ctx, 'wdf-jc120');
        input.connect(node);
        node.connect(tone.input);
      } catch (e) {
        console.warn('WDF JC-120 worklet 未就绪,直通:', e);
        input.connect(tone.input);
      }
      tone.output.connect(masterGain);
      masterGain.connect(output);

      return {
        input,
        output,
        update(key, value) {
          const t = ctx.currentTime;
          switch (key) {
            case 'gain':
              node?.parameters.get('gain')?.setTargetAtTime(value, t, 0.03);
              break;
            case 'chorus':
              node?.parameters.get('chorus')?.setTargetAtTime(value, t, 0.01);
              break;
            case 'bass':
            case 'mid':
            case 'treble':
            case 'presence':
              tone.update(key, value);
              break;
            case 'master':
              masterGain.gain.setTargetAtTime(levelDbToGain(value), t, 0.03);
              break;
          }
        },
        dispose() {
          [input, node, ...tone.nodes, masterGain, output]
            .forEach((n) => n?.disconnect());
        },
      };
    },
  };
}
