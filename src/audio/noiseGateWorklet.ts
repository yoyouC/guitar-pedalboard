/**
 * Noise Gate 的 AudioWorklet 处理器,以 Blob 形式内联加载,免额外构建配置。
 * 算法:以整块 RMS 与阈值比较得到目标增益(0/1),再按 attack/release 系数
 * 对增益做逐样本平滑,避免开关爆音与立体声像抖动。
 */
const processorSource = `
class NoiseGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -50, minValue: -90, maxValue: 0 },
      { name: 'attack', defaultValue: 0.005, minValue: 0.001, maxValue: 0.05 },
      { name: 'release', defaultValue: 0.08, minValue: 0.01, maxValue: 0.5 },
    ];
  }

  constructor() {
    super();
    this.gain = 0;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !input[0].length) return true;

    const thresholdDb = params.threshold[0];
    const attack = Math.max(0.0001, params.attack[0]);
    const release = Math.max(0.0001, params.release[0]);
    const threshold = Math.pow(10, thresholdDb / 20);

    // 整块 RMS(取第 0 声道估算)
    const ref = input[0];
    let sum = 0;
    for (let i = 0; i < ref.length; i++) sum += ref[i] * ref[i];
    const rms = Math.sqrt(sum / ref.length);

    const target = rms > threshold ? 1 : 0;
    const tau = target > this.gain ? attack : release;
    const coeff = 1 - Math.exp(-1 / (tau * sampleRate));

    let g = this.gain;
    for (let ch = 0; ch < input.length; ch++) {
      const inp = input[ch];
      const out = output[ch];
      g = this.gain;
      for (let i = 0; i < inp.length; i++) {
        g += (target - g) * coeff;
        out[i] = inp[i] * g;
      }
    }
    this.gain = g;
    return true;
  }
}

registerProcessor('noise-gate', NoiseGateProcessor);
`;

let loaded = false;

/** 幂等加载,使用前必须先 await */
export async function loadNoiseGate(ctx: AudioContext): Promise<void> {
  if (loaded) return;
  const url = URL.createObjectURL(
    new Blob([processorSource], { type: 'application/javascript' }),
  );
  try {
    await ctx.audioWorklet.addModule(url);
    loaded = true;
  } finally {
    URL.revokeObjectURL(url);
  }
}
