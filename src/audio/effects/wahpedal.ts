import type { EffectDefinition, EffectInstance } from './types';

const SMOOTH = 0.015;
/** 兜底(无 AudioWorklet)带通扫频范围 */
const FALLBACK_MIN_HZ = 350;
const FALLBACK_MAX_HZ = 2200;
const posToFreq = (pos: number) =>
  FALLBACK_MIN_HZ * Math.pow(FALLBACK_MAX_HZ / FALLBACK_MIN_HZ, pos / 100);

/**
 * Wah Pedal 哇音踏板(Crybaby 白盒模型)。
 * 核心为 'crybaby-wah' AudioWorklet(见 wahWorklet.ts):
 * Julius O. Smith 实测拟合的二阶谐振器,踏板位置同时驱动谐振频率
 * (450Hz→2.2kHz)与 Q(8→4),分子含 DC 零点,峰值增益 +14→+20dB。
 * position 参数由 UI 摇杆驱动,后续可接 MIDI CC。
 * worklet 未加载时回退为普通扫频带通(明显不如,但保证可用)。
 * 注:不采用 defineWorkletEffect 数据化工厂——本效果有兜底带通链与
 * 独立 levelGain 输出级,且参数键经改名/缩放(wah/resoScale),超出工厂形状。
 */
export const wahpedalEffect: EffectDefinition = {
  id: 'wahpedal',
  name: 'Wah',
  color: '#23262b',
  params: [
    { key: 'position', label: 'TREADLE', min: 0, max: 100, step: 1, defaultValue: 50, unit: '%' },
    { key: 'reso', label: 'RESO', min: 50, max: 200, step: 1, defaultValue: 100, unit: '%' },
    { key: 'level', label: 'LEVEL', min: 0, max: 200, step: 1, defaultValue: 100, unit: '%' },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const levelGain = ctx.createGain();
    levelGain.gain.value = 1;

    let wahNode: AudioWorkletNode | null = null;
    let fallback: BiquadFilterNode | null = null;

    try {
      wahNode = new AudioWorkletNode(ctx, 'crybaby-wah');
      input.connect(wahNode);
      wahNode.connect(levelGain);
    } catch {
      // worklet 处理器未加载,回退为扫频带通
      console.warn('[wahpedal] AudioWorklet "crybaby-wah" 不可用,回退为带通');
      fallback = ctx.createBiquadFilter();
      fallback.type = 'bandpass';
      fallback.frequency.value = posToFreq(50);
      fallback.Q.value = 6;
      input.connect(fallback);
      fallback.connect(levelGain);
    }
    levelGain.connect(output);

    return {
      input,
      output,
      update(key, value) {
        const t = ctx.currentTime;
        if (wahNode) {
          switch (key) {
            case 'position':
              wahNode.parameters.get('wah')?.setTargetAtTime(value / 100, t, SMOOTH);
              break;
            case 'reso':
              wahNode.parameters.get('resoScale')?.setTargetAtTime(value / 100, t, SMOOTH);
              break;
            case 'level':
              levelGain.gain.setTargetAtTime(value / 100, t, SMOOTH);
              break;
          }
        } else if (fallback) {
          switch (key) {
            case 'position':
              fallback.frequency.setTargetAtTime(posToFreq(value), t, SMOOTH);
              break;
            case 'reso':
              fallback.Q.setTargetAtTime((value / 100) * 6, t, SMOOTH);
              break;
            case 'level':
              levelGain.gain.setTargetAtTime(value / 100, t, SMOOTH);
              break;
          }
        }
      },
      dispose() {
        input.disconnect();
        output.disconnect();
        levelGain.disconnect();
        if (wahNode) {
          try {
            wahNode.port.postMessage({ type: 'suspend' });
            wahNode.port.onmessage = null;
          } catch {
            /* 端口已关闭 */
          }
          wahNode.disconnect();
          wahNode = null;
        }
        if (fallback) {
          fallback.disconnect();
          fallback = null;
        }
      },
    };
  },
};
