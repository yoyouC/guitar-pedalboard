/**
 * 4x 抗混叠重采样:多相升采样 + 48 抽头(47 阶)Blackman-sinc FIR 降采样。
 * 替代线性插值(镜像抑制差,非线性处理后产生混叠"滋滋"声)。
 *
 * WDF DSP 单一来源(ADR-0003):champ/bogner/twin/ac30/jc120 等 worklet 经
 * `?raw` 取本文件源码拼装 Blob;eval/测试直接 import。只用单行 import 与
 * 内联 export(buildProcessorSource 依赖此约定剥离模块语法)。
 * 本文件以 worklet 内联版为权威提取(5 份内联拷贝逐字符等价,issue #7 审计)。
 */

export const OS_FACTOR = 4;
export const FIR_TAPS = 48;

/** 47 阶窗 sinc 低通(截止 17.3kHz ≈ 0.09·fs_os),和为 1。
 *  NT=48 的过渡带足够窄,镜像区(30.7kHz 起)抑制 ≥77dB。 */
export function makeAntiAliasFIR() {
  const M = FIR_TAPS - 1;
  const fc = 0.09; // 每 OS 样本周期数(0.5 = OS 奈奎斯特)
  const h = new Float32Array(FIR_TAPS);
  let sum = 0;
  for (let n = 0; n < FIR_TAPS; n++) {
    const x = n - M / 2;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w =
      0.42 - 0.5 * Math.cos((2 * Math.PI * n) / M) + 0.08 * Math.cos((4 * Math.PI * n) / M);
    h[n] = sinc * w;
    sum += h[n];
  }
  for (let n = 0; n < FIR_TAPS; n++) h[n] /= sum;
  return h;
}

/** 4x 多相升采样器:y_k[n] = L·Σ_m h[k+Lm]·x[n-m] */
export class Upsampler4x {
  /** @param {Float32Array} h makeAntiAliasFIR 的系数 */
  constructor(h) {
    /** @type {Float32Array[]} */
    this.phases = [];
    const mLen = FIR_TAPS / OS_FACTOR;
    for (let k = 0; k < OS_FACTOR; k++) {
      const pk = new Float32Array(mLen);
      for (let m = 0; m < mLen; m++) pk[m] = OS_FACTOR * h[k + OS_FACTOR * m];
      this.phases.push(pk);
    }
    this.hist = new Float32Array(mLen);
    this.idx = 0;
  }

  /** 输入一个基率样本,把 4 个 OS 样本写入 out[0..3] */
  process(out, xn) {
    this.idx = (this.idx - 1 + this.hist.length) % this.hist.length;
    this.hist[this.idx] = xn;
    for (let k = 0; k < OS_FACTOR; k++) {
      const pk = this.phases[k];
      let acc = 0;
      let j = this.idx;
      for (let m = 0; m < pk.length; m++) {
        acc += pk[m] * this.hist[j];
        j = (j + 1) % this.hist.length;
      }
      out[k] = acc;
    }
  }
}

/** 4x FIR 降采样器:out[n] = Σ_m h[m]·y[4n-m] */
export class Decimator4x {
  /** @param {Float32Array} h makeAntiAliasFIR 的系数 */
  constructor(h) {
    this.h = h;
    this.hist = new Float32Array(FIR_TAPS);
    this.idx = 0;
  }

  /** 推入 4 个 OS 样本,返回 1 个基率样本 */
  process(y0, y1, y2, y3) {
    const ys = [y0, y1, y2, y3];
    for (let k = 0; k < OS_FACTOR; k++) {
      this.idx = (this.idx - 1 + FIR_TAPS) % FIR_TAPS;
      this.hist[this.idx] = ys[k];
    }
    let acc = 0;
    let j = this.idx;
    for (let m = 0; m < FIR_TAPS; m++) {
      acc += this.h[m] * this.hist[j];
      j = (j + 1) % FIR_TAPS;
    }
    return acc;
  }
}
