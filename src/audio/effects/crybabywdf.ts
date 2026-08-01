import type { EffectDefinition, EffectInstance } from './types';
import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from '../level';

/**
 * Wah WDF ⚗:Crybaby GCB-95 哇音踏板的白盒电路建模(三 BJT:输入缓冲射随 +
 * 集电极反馈偏置增益级 + 射随 Miller 可变电容 + 500mH 电感谐振腔,
 * 9 节点隐式 Newton,4x 过采样)。worklet 实现,加载失败兜底直通。
 * position 由摇杆驱动(a-rate 逐样本),语义与 DSP 版 wahpedal 一致:
 * 0=跟位(低频),100=顶位(高频)。
 */
export const crybabyWdfEffect: EffectDefinition = {
  id: 'crybabywdf',
  name: 'Wah WDF ⚗',
  color: '#3a3f46',
  params: [
    { key: 'position', label: 'TREADLE', min: 0, max: 100, step: 1, defaultValue: 50, unit: '%' },
    { key: 'level', label: 'LEVEL', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: 0, unit: 'dB' },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();
    let node: AudioWorkletNode | null = null;
    try {
      node = new AudioWorkletNode(ctx, 'wdf-crybaby');
      input.connect(node);
      node.connect(output);
    } catch (e) {
      console.warn('Crybaby WDF worklet 未就绪,直通:', e);
      input.connect(output);
    }
    // 内部电平归一化:默认 position=50 时接通≈旁通响度
    // (eval L1 宽带多音 riff RMS 增益实测 1.26,×1/1.26≈0.8)
    output.gain.value = 0.8;
    node?.parameters.get('level')?.setValueAtTime(1, ctx.currentTime);
    return {
      input,
      output,
      update(key, value) {
        const t = ctx.currentTime;
        if (key === 'level') {
          node?.parameters.get('level')?.setTargetAtTime(levelDbToGain(value), t, 0.03);
        } else if (key === 'position') {
          // 行程映射(参照真实踏板的非线性电位器锥度 + 有限机械行程,
          // GEO "Pot Secrets"):电路谐振峰频率相对电位器位置 w 高度非线性
          // (w=0→0.75 仅扫 450→750Hz,>0.9 才冲到 1.3kHz+),线性映射会让
          // 大部分摇杆行程窝在低中频窄区、听感像音量踏板。指数锥度把行程
          // 均匀摊到峰频上,并把顶位限制在 w=0.94(再往上 Q2 偏置塌陷、
          // 谐振退化为宽架,真实踏板机械行程同样到不了电气端点)。
          const u = value / 100;
          const w = 0.02 + 0.92 * Math.pow(u, 0.45);
          node?.parameters.get('position')?.setTargetAtTime(w * 100, t, 0.03);
        } else {
          node?.parameters.get(key)?.setTargetAtTime(value, t, 0.03);
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
