/**
 * MXR Dyna Comp 风格 OTA 压缩 DSP 核——单一来源(ADR-0003)。
 *
 * 电路参考(ElectroSmash MXR Dyna Comp 分析):CA3080 OTA 作压控增益级
 * (线性 VCA,非线性可忽略,故无需过采样),侧链为**反馈拓扑**(包络检波
 * 取自 OTA 输出),启动/释放 RC 固定(面板无 Attack/Release 旋钮)。
 *
 * 链路(每通道一个 DynaCompCore 实例):
 *   输入 → OTA VCA(y = g·x,反馈环单位延迟)→ 反馈峰值包络(dB)
 *   → 目标衰减 t = kFb·max(0, e − thr)(kFb=10 → 静态压缩比 11:1,
 *   thr 由 SENSITIVITY 反比设定)→ RC 一阶平滑(dB 域,固定快启动 2ms /
 *   释放 250ms)→ g = 10^(−GR/20);输出 = 压缩核输出 × LEVEL(线性,
 *   dB 域由外层转换)。
 *
 * 双模式消费:worklet(dynacompWorklet.ts)经 `?raw` 取源码字符串拼装 Blob;
 * eval/测试直接 import。只用单行 import 与内联 export
 * (buildProcessorSource 依赖此约定剥离模块语法)。
 * 本文件以原 worklet 内联版为权威逐表达式平移(issue #7,音色零变化);
 * 内联版 attack/release/kFb 为硬编码(2ms / 250ms / 10),旧 core 的
 * options 形参随之废弃,构造签名取内联版的位置参数 (fs)。
 */

/** SENSITIVITY → 阈值:thr = THR_MAX − THR_SPAN·s(灵敏度 = 阈值反比) */
const THR_MAX_DB = -10; // s=0:仅最响的信号触发
const THR_SPAN_DB = 45; // s=1:-55dB,弱信号也深度压缩
/** 包络下限,防 log10(0) */
const ENV_FLOOR = 1e-7;

/**
 * 单通道 Dyna Comp 风格 OTA 压缩核心(每样本 process(x) → y)。
 * 逐表达式平移自原 worklet 内联版;采样率由构造注入。
 */
export class DynaCompCore {
  /** @param {number} fs 采样率 */
  constructor(fs) {
    this.cAtt = 1 - Math.exp(-1 / (0.002 * fs)); // 启动 2ms
    this.cRel = 1 - Math.exp(-1 / (0.250 * fs)); // 释放 250ms
    this.kFb = 10;                               // 静态压缩比 1+kFb = 11:1
    this.thrDb = THR_MAX_DB - THR_SPAN_DB * 0.5;
    this.grDb = 0;
    this.gain = 1;
  }

  /** sensitivity 0~1 → 阈值 −10 ~ −55dB(灵敏度 = 阈值反比) */
  setSensitivity(s) {
    const sc = Math.min(1, Math.max(0, s));
    this.thrDb = THR_MAX_DB - THR_SPAN_DB * sc;
  }

  process(x) {
    // 1) OTA VCA(用上一样本的增益,反馈环单位延迟保证因果稳定)
    const y = this.gain * x;
    // 2) 反馈峰值包络(dB)
    const inst = Math.abs(y);
    const envDb = 20 * Math.log10(inst > ENV_FLOOR ? inst : ENV_FLOOR);
    // 3) 目标衰减 + RC 一阶平滑(dB 域:充电快=启动,放电慢=释放)
    const over = envDb - this.thrDb;
    const target = over > 0 ? this.kFb * over : 0;
    const c = target > this.grDb ? this.cAtt : this.cRel;
    this.grDb += c * (target - this.grDb);
    if (this.grDb < 1e-9 && target === 0) this.grDb = 0; // 防 denormal 爬行
    this.gain = Math.pow(10, -this.grDb / 20);
    return y;
  }
}

/**
 * Dyna Comp 全链路引擎。process(inputs, outputs, params) 语义与
 * AudioWorkletProcessor.process 一致;采样率由构造注入(替代 worklet 全局
 * sampleRate),引擎内不含任何 AudioWorklet API。每通道独立压缩链
 * (独立包络/增益状态,防立体声串扰);sensitivity 变化做脏检查缓存。
 */
export class WdfDynaCompEngine {
  /** @param {number} sampleRate 采样率 */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    /** @type {{core: DynaCompCore, lastSens: number}[]} */
    this.chains = [];
  }

  createChain() {
    return { core: new DynaCompCore(this.sampleRate), lastSens: -1 };
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) this.chains.push(this.createChain());

    const sens = params.sensitivity[0] / 100;
    const level = params.level[0];

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      if (c.lastSens !== sens) {
        c.core.setSensitivity(sens);
        c.lastSens = sens;
      }
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        out[i] = c.core.process(inp[i]) * level;
      }
    }
    return true;
  }
}
