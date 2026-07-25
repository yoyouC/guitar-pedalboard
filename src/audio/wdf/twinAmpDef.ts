/**
 * WDF Twin Reverb(实验):Fender AB763 风格美式清音。
 * worklet(twinWorklet.ts)负责 WDF 前级/阴极跟随器/6L6 后级与 GAIN;
 * 音色栈/BRIGHT/MASTER 用原生节点(同 wdfBognerDef 的接线模式)。
 * 固定 voicing:500Hz -3dB 中频凹陷(Fender scooped 性格)。
 * 注册接线(AMP_REGISTRY / AudioEngine 预载)由主代理收口。
 */
import type { EffectDefinition, EffectInstance } from '../effects/types';
import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from '../level';

export function wdfTwinDef(): EffectDefinition {
  const DEFAULTS = {
    gain: 40, bass: 55, mid: 40, treble: 60, presence: 50, master: -6, bright: 20,
  };
  return {
    id: 'wdftwin',
    name: 'WDF Twin ⚗',
    color: '#3d6e9e',
    params: [
      { key: 'gain', label: 'GAIN', min: 0, max: 100, step: 1, defaultValue: DEFAULTS.gain },
      { key: 'bass', label: 'BASS', min: 0, max: 100, step: 1, defaultValue: DEFAULTS.bass },
      { key: 'mid', label: 'MID', min: 0, max: 100, step: 1, defaultValue: DEFAULTS.mid },
      { key: 'treble', label: 'TREBLE', min: 0, max: 100, step: 1, defaultValue: DEFAULTS.treble },
      { key: 'presence', label: 'PRESENCE', min: 0, max: 100, step: 1, defaultValue: DEFAULTS.presence },
      { key: 'master', label: 'MASTER', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: DEFAULTS.master, unit: 'dB' },
      { key: 'bright', label: 'BRIGHT', min: 0, max: 100, step: 1, defaultValue: DEFAULTS.bright },
    ],
    create(ctx: AudioContext): EffectInstance {
      const input = ctx.createGain();
      const output = ctx.createGain();

      let node: AudioWorkletNode | null = null;
      // Fender 中频凹陷 voicing(固定):500Hz -3dB
      const voicing = ctx.createBiquadFilter();
      voicing.type = 'peaking';
      voicing.frequency.value = 500;
      voicing.Q.value = 1.0;
      voicing.gain.value = -3;
      // 音色栈
      const bass = ctx.createBiquadFilter();
      bass.type = 'lowshelf';
      bass.frequency.value = 120;
      const mid = ctx.createBiquadFilter();
      mid.type = 'peaking';
      mid.frequency.value = 500;
      mid.Q.value = 1.0;
      const treble = ctx.createBiquadFilter();
      treble.type = 'highshelf';
      treble.frequency.value = 3000;
      const presence = ctx.createBiquadFilter();
      presence.type = 'highshelf';
      presence.frequency.value = 5000;
      // BRIGHT:高频高架 0~+6dB(Fender bright cap 性格)
      const bright = ctx.createBiquadFilter();
      bright.type = 'highshelf';
      bright.frequency.value = 4000;
      const masterGain = ctx.createGain();

      const pctToDb = (v: number) => ((v - 50) / 50) * 12;
      bass.gain.value = pctToDb(DEFAULTS.bass);
      mid.gain.value = pctToDb(DEFAULTS.mid);
      treble.gain.value = pctToDb(DEFAULTS.treble);
      presence.gain.value = (DEFAULTS.presence / 100) * 8;
      bright.gain.value = (DEFAULTS.bright / 100) * 6;
      masterGain.gain.value = levelDbToGain(DEFAULTS.master);

      try {
        node = new AudioWorkletNode(ctx, 'wdf-twin');
        input.connect(node);
        node.connect(voicing);
      } catch (e) {
        console.warn('WDF Twin worklet 未就绪,直通:', e);
        input.connect(voicing);
      }
      voicing.connect(bass);
      bass.connect(mid);
      mid.connect(treble);
      treble.connect(presence);
      presence.connect(bright);
      bright.connect(masterGain);
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
            case 'bass':
              bass.gain.setTargetAtTime(pctToDb(value), t, 0.03);
              break;
            case 'mid':
              mid.gain.setTargetAtTime(pctToDb(value), t, 0.03);
              break;
            case 'treble':
              treble.gain.setTargetAtTime(pctToDb(value), t, 0.03);
              break;
            case 'presence':
              presence.gain.setTargetAtTime((value / 100) * 8, t, 0.03);
              break;
            case 'bright':
              bright.gain.setTargetAtTime((value / 100) * 6, t, 0.03);
              break;
            case 'master':
              masterGain.gain.setTargetAtTime(levelDbToGain(value), t, 0.03);
              break;
          }
        },
        dispose() {
          [input, node, voicing, bass, mid, treble, presence, bright, masterGain, output]
            .forEach((n) => n?.disconnect());
        },
      };
    },
  };
}
