/**
 * CryBaby 哇音踏板的 AudioWorklet 处理器,以 Blob 形式内联加载。
 *
 * 模型来源:Julius O. Smith 对实物 CryBaby 的实测拟合
 * (LAC 2008《Virtual Electric Guitars and Effects Using Faust and Octave》
 * 及 DAFX 2nd ed. wahcontrols.m),踏板位置 wah∈[0,1] 同时驱动:
 *   fr = 450 · 2^(2.3·wah)      谐振频率 450Hz(跟位)→ ~2.2kHz(顶位)
 *   Q  = 2^(2·(1-wah)+1)        谐振 Q 8(跟位,尖)→ 4(顶位,宽)
 * 滤波器为二阶谐振器 H(z) = b0·(1 - z⁻¹) / (1 + a1·z⁻¹ + a2·z⁻²):
 *   极点 R = 1 - π·frn/Q, θ = 2π·frn;a1 = -2R·cosθ, a2 = R²
 *   分子含 DC 零点 —— 这是真品"跟位不空、顶位不刺"的关键,
 *   普通对称带通(两侧 6dB/oct 衰减)没有这种体态。
 * 论文用总体增益 g 拟合实测响度,这里改为数值峰值归一化:
 *   在 z = e^{jθ} 处精确求 |H| 并缩放到目标峰值曲线(跟位 +14dB → 顶位 +20dB),
 *   谐振形状与 Smith 模型一致,响度行为可控。
 * RESO 参数仅缩放 Q(改变峰宽),不改变峰值增益。
 */
import { createWorkletLoader } from './workletLoader';

const processorSource = `
class CrybabyWahProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'wah', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'resoScale', defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: 'a-rate' },
    ];
  }

  constructor() {
    super();
    // 每声道 DF-II Transposed 状态(最多 2 声道)
    this.s1 = [0, 0];
    this.s2 = [0, 0];
    this.suspended = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'suspend') this.suspended = true;
    };
  }

  process(inputs, outputs, params) {
    if (this.suspended) return false;
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !input[0].length) return true;

    const wahArr = params.wah;
    const resoArr = params.resoScale;
    const n = input[0].length;
    const TWO_PI = 2 * Math.PI;

    for (let i = 0; i < n; i++) {
      const w = wahArr.length > 1 ? wahArr[i] : wahArr[0];
      const rs = resoArr.length > 1 ? resoArr[i] : resoArr[0];

      // Smith 实测拟合:fr / Q 随踏板位置变化
      const Q = Math.pow(2, 2 * (1 - w) + 1) * rs;
      const fr = 450 * Math.pow(2, 2.3 * w);
      const frn = fr / sampleRate;
      const R = 1 - Math.PI * frn / Q;
      const theta = TWO_PI * frn;
      const a1 = -2 * R * Math.cos(theta);
      const a2 = R * R;

      // 峰值归一化:在谐振角 θ 处精确计算 |N/D|,缩放到目标峰值
      const c1 = Math.cos(theta);
      const c2 = Math.cos(2 * theta);
      const N2 = 2 - 2 * c1; // |(1 - e^{-jθ})|²
      const D2 = (1 + a1 * a1 + a2 * a2) + 2 * a1 * (1 + a2) * c1 + 2 * a2 * c2;
      const peakTarget = Math.pow(10, (14 + 6 * w) / 20);
      // 数值防御:D2 理论非负但抵消严重,负值/NaN 时 b0 取 0(本样本直静音,不污染状态)
      const b0raw = peakTarget * Math.sqrt(Math.max(0, D2 / N2));
      const b0 = isFinite(b0raw) ? b0raw : 0;

      for (let ch = 0; ch < input.length && ch < 2; ch++) {
        const x = input[ch][i];
        let y = b0 * x + this.s1[ch];
        if (!isFinite(y)) {
          // 状态被 NaN 污染时自恢复:清零滤波状态,本样本输出 0(避免永久死寂)
          this.s1[ch] = 0;
          this.s2[ch] = 0;
          y = 0;
        } else {
          this.s1[ch] = -b0 * x - a1 * y + this.s2[ch];
          this.s2[ch] = -a2 * y;
        }
        output[ch][i] = y;
      }
    }
    return true;
  }
}

registerProcessor('crybaby-wah', CrybabyWahProcessor);
`;

/** 幂等加载(按 AudioContext 注册),使用前必须先 await */
export const loadWahWorklet = createWorkletLoader(processorSource);
