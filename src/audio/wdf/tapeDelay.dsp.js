/**
 * 磁带延迟(Echoplex EP-3 风格)DSP 核——单一来源(ADR-0003)。
 *
 * 链路(每通道一个独立 TapeDelayEngine 实例,全部非线性在 4x 过采样域):
 *   输入 → Up4(多相升采样)
 *        → 录制软削波(磁带饱和,kneeRec 随 SATURATION 下降)
 *        → (+) 写入环行延迟线
 *        → 调制读出头:wow 0.8Hz 正弦 + flutter 6.4Hz 正弦(WOW 控制深度),
 *          Catmull-Rom 四点插值;TIME 经 30ms 一阶平滑(带头移位式俯冲)
 *        → 磁头损耗:3.3kHz 一阶 LP + 30Hz 一阶 HP(每次重复各过一次,含首次)
 *        → 循环软削波(小信号增益恒 1,kneeLoop 随 SATURATION 下降;
 *          FEEDBACK>100% 时提供限幅 → 自激振荡有界不发散)
 *        → ×FEEDBACK(0~1.1)回馈到写入端
 *   湿信号(读出头后)→ Down4(48 阶 FIR 抗混叠)→ ×MIX 与恒 1 干路相加
 *   过采样共享核见 ./resample.dsp.js。
 *
 * 双模式消费:worklet 经 `?raw` 取源码字符串拼装 Blob;eval/测试直接 import。
 * 只用单行 import 与内联 export(buildProcessorSource 依赖此约定剥离)。
 * 本文件以原 tapedelayWorklet.ts 内联版为权威逐表达式平移(常量名沿用旧
 * TS core 的 TAPE_* 命名以兼容 eval,值与内联版逐项审计一致,issue #7)。
 */
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from './resample.dsp.js';

export const TAPE_WOW_HZ = 0.8; // wow 漂移速率(0.5~2Hz 带内)
export const TAPE_FLUTTER_HZ = 6.4; // flutter 速率(5~8Hz 带内)
export const TAPE_WOW_MAX_S = 3e-3; // WOW=100 时 wow 峰值深度
export const TAPE_FLUTTER_MAX_S = 0.35e-3; // WOW=100 时 flutter 峰值深度
export const TAPE_LOOP_LP_HZ = 3300; // 磁头损耗低通(每次重复)
export const TAPE_LOOP_HP_HZ = 30; // 环内 DC 阻断(自激时防 DC 累积)
export const TAPE_TIME_MIN_MS = 50;
export const TAPE_TIME_MAX_MS = 1000;

const MAX_DELAY_S = 1.1; // 环行缓冲时长(覆盖 1000ms + 调制余量)
const TIME_SMOOTH_S = 0.03; // TIME 平滑时间常数

/**
 * p=4 代数软削波:y = x / (1 + (x/knee)^4)^(1/4)。
 * 奇对称(无 DC/偶次分量),小信号增益精确为 1(反馈阈值不随膝点漂移),
 * 大信号渐近 ±knee。knee 越小饱和越重。
 */
export function tapeSoftClip(x, knee) {
  const t = x / knee;
  return x / Math.pow(1 + t * t * t * t, 0.25);
}

/**
 * 单通道磁带延迟引擎(每样本处理)。
 * @param {number} fs 基率采样率(如 48000),内部 4x 过采样
 */
export class TapeDelayEngine {
  constructor(fs) {
    /** @type {number} 过采样域采样率 */
    this.fsOs = fs * OS_FACTOR;
    const fir = makeAntiAliasFIR();
    this.up = new Upsampler4x(fir);
    this.down = new Decimator4x(fir);
    this.buf = new Float32Array(Math.ceil(MAX_DELAY_S * this.fsOs));
    this.wIdx = 0;
    // 预计算系数(构造时按 fsOs 算好)
    this.aD = 1 - Math.exp(-1 / (TIME_SMOOTH_S * this.fsOs)); // TIME 平滑
    this.aLp = 1 - Math.exp((-2 * Math.PI * TAPE_LOOP_LP_HZ) / this.fsOs); // 磁头 LP
    this.aHp = 1 - Math.exp((-2 * Math.PI * TAPE_LOOP_HP_HZ) / this.fsOs); // 环内 HP
    this.dWow = (2 * Math.PI * TAPE_WOW_HZ) / this.fsOs; // wow 相位增量(OS 样本)
    this.dFl = (2 * Math.PI * TAPE_FLUTTER_HZ) / this.fsOs; // flutter 相位增量
    this.fbGain = 0.4;
    this.kneeRec = 2;
    this.kneeLoop = 1.1;
    this.wetGain = 0.3;
    this.wowAmpOs = 0;
    this.flAmpOs = 0;
    this.dTarget = (400 / 1000) * this.fsOs;
    this.dSmooth = this.dTarget;
    this.wowPhase = 0;
    this.flutterPhase = 0;
    this.lpY = 0;
    this.hpY = 0;
    this.osIn = new Float32Array(OS_FACTOR);
    this.osOut = [0, 0, 0, 0];
    this.setWow(30);
    this.setSaturation(40);
  }

  setTime(ms) {
    const v = Math.min(TAPE_TIME_MAX_MS, Math.max(TAPE_TIME_MIN_MS, ms));
    this.dTarget = (v / 1000) * this.fsOs;
  }

  setFeedback(pct) {
    this.fbGain = Math.min(110, Math.max(0, pct)) / 100;
  }

  setWow(v) {
    const k = Math.min(100, Math.max(0, v)) / 100;
    this.wowAmpOs = k * TAPE_WOW_MAX_S * this.fsOs;
    this.flAmpOs = k * TAPE_FLUTTER_MAX_S * this.fsOs;
  }

  setSaturation(v) {
    const k = Math.min(100, Math.max(0, v)) / 100;
    this.kneeRec = 2 * Math.pow(0.125, k); // 2.0 → 0.25
    this.kneeLoop = 1.1 - 0.75 * k; // 1.1 → 0.35
  }

  setMix(pct) {
    this.wetGain = Math.min(100, Math.max(0, pct)) / 100;
  }

  process(x) {
    const len = this.buf.length;
    this.up.process(this.osIn, x);
    for (let k = 0; k < OS_FACTOR; k++) {
      const rec = tapeSoftClip(this.osIn[k], this.kneeRec);
      // 读出头位置:TIME 平滑 + wow/flutter 调制
      this.dSmooth += this.aD * (this.dTarget - this.dSmooth);
      this.wowPhase += this.dWow;
      if (this.wowPhase > Math.PI) this.wowPhase -= 2 * Math.PI;
      this.flutterPhase += this.dFl;
      if (this.flutterPhase > Math.PI) this.flutterPhase -= 2 * Math.PI;
      const mod =
        this.wowAmpOs * Math.sin(this.wowPhase) + this.flAmpOs * Math.sin(this.flutterPhase);
      let pos = this.wIdx - this.dSmooth - mod;
      if (pos < 0) pos += len;
      // Catmull-Rom 四点插值
      const i = Math.floor(pos);
      const f = pos - i;
      const x0 = this.buf[(i - 1 + len) % len];
      const x1 = this.buf[i % len];
      const x2 = this.buf[(i + 1) % len];
      const x3 = this.buf[(i + 2) % len];
      const rd =
        0.5 *
        (2 * x1 +
          (-x0 + x2) * f +
          (2 * x0 - 5 * x1 + 4 * x2 - x3) * f * f +
          (-x0 + 3 * x1 - 3 * x2 + x3) * f * f * f);
      // 磁头损耗(每次重复):LP + HP(DC 阻断)
      this.lpY += this.aLp * (rd - this.lpY);
      this.hpY += this.aHp * (this.lpY - this.hpY);
      const wet = this.lpY - this.hpY;
      // 写回:录制信号 + 反馈(循环软削波限幅,保证 fb>1 有界)
      this.buf[this.wIdx] = rec + this.fbGain * tapeSoftClip(wet, this.kneeLoop);
      this.wIdx = (this.wIdx + 1) % len;
      this.osOut[k] = wet;
    }
    const y = this.down.process(this.osOut[0], this.osOut[1], this.osOut[2], this.osOut[3]);
    return x + this.wetGain * y;
  }
}

/**
 * 磁带延迟全链路引擎。process(inputs, outputs, params) 语义与
 * AudioWorkletProcessor.process 一致;采样率由构造注入(替代 worklet 全局
 * sampleRate),引擎内不含任何 AudioWorklet API。每块无条件调 5 个 setter
 * (无脏检查),与原内联处理器一致。
 */
export class WdfTapeDelayEngine {
  /** @param {number} sampleRate 基率采样率 */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    /** @type {TapeDelayEngine[]} 每通道独立引擎 */
    this.engines = [];
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.engines.length < input.length)
      this.engines.push(new TapeDelayEngine(this.sampleRate));
    for (let ch = 0; ch < input.length; ch++) {
      const eng = this.engines[ch];
      eng.setTime(params.time[0]);
      eng.setFeedback(params.feedback[0]);
      eng.setWow(params.wow[0]);
      eng.setSaturation(params.saturation[0]);
      eng.setMix(params.mix[0]);
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) out[i] = eng.process(inp[i]);
    }
    return true;
  }
}
