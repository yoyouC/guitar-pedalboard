/**
 * 磁带延迟(Echoplex EP-3 风格)DSP 核心 —— 纯 TS,Node 可测,无 AudioContext 依赖。
 *
 * 结构(每通道一个独立实例,全部非线性在 4x 过采样域进行):
 *   输入 → Up4(多相升采样)
 *        → 录制软削波(磁带饱和,kneeRec 随 SATURATION 下降)
 *        → (+) 写入环行延迟线
 *        → 调制读出头:wow 0.8Hz 正弦 + flutter 6.4Hz 正弦(WOW 控制深度),
 *          Catmull-Rom 四点插值;TIME 经 30ms 一阶平滑(带头移位式俯冲)
 *        → 磁头损耗:3.3kHz 一阶 LP + 30Hz 一阶 HP(每次重复各过一次,含首次)
 *        → 循环软削波(小信号增益恒 1,kneeLoop 随 SATURATION 下降:
 *          重复逐次变脏;FEEDBACK>100% 时提供限幅 → 自激振荡有界不发散)
 *        → ×FEEDBACK(0~1.1)回馈到写入端
 *   湿信号(读出头后)→ Down4(48 阶 FIR 抗混叠)→ ×MIX 与恒 1 干路相加
 *
 * worklet(src/audio/wdf/tapedelayWorklet.ts)内联同一份 JS —— 改动必须两边同步。
 */
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from './resample.ts';

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
export function tapeSoftClip(x: number, knee: number): number {
  const t = x / knee;
  return x / Math.pow(1 + t * t * t * t, 0.25);
}

export class TapeDelayEngine {
  private readonly fsOs: number;
  private readonly up: Upsampler4x;
  private readonly down: Decimator4x;
  private readonly buf: Float32Array;
  private wIdx = 0;

  // 预计算系数(构造时按 fsOs 算好)
  private readonly aD: number; // TIME 平滑
  private readonly aLp: number; // 磁头 LP
  private readonly aHp: number; // 环内 HP
  private readonly dWow: number; // wow 相位增量(OS 样本)
  private readonly dFl: number; // flutter 相位增量

  // 参数(经 setter 预计算)
  private dTarget: number; // 目标延迟(OS 样本)
  private fbGain = 0.4;
  private wowAmpOs = 0; // wow 峰值(OS 样本)
  private flAmpOs = 0;
  private kneeRec = 2;
  private kneeLoop = 1.1;
  private wetGain = 0.3;

  // 状态
  private dSmooth: number;
  private wowPhase = 0;
  private flutterPhase = 0;
  private lpY = 0;
  private hpY = 0;
  private readonly osIn = new Float32Array(OS_FACTOR);
  private readonly osOut = [0, 0, 0, 0];

  /** @param fs 基率采样率(如 48000),内部 4x 过采样 */
  constructor(fs: number) {
    this.fsOs = fs * OS_FACTOR;
    const fir = makeAntiAliasFIR();
    this.up = new Upsampler4x(fir);
    this.down = new Decimator4x(fir);
    this.buf = new Float32Array(Math.ceil(MAX_DELAY_S * this.fsOs));
    this.aD = 1 - Math.exp(-1 / (TIME_SMOOTH_S * this.fsOs));
    this.aLp = 1 - Math.exp((-2 * Math.PI * TAPE_LOOP_LP_HZ) / this.fsOs);
    this.aHp = 1 - Math.exp((-2 * Math.PI * TAPE_LOOP_HP_HZ) / this.fsOs);
    this.dWow = (2 * Math.PI * TAPE_WOW_HZ) / this.fsOs;
    this.dFl = (2 * Math.PI * TAPE_FLUTTER_HZ) / this.fsOs;
    this.dTarget = (400 / 1000) * this.fsOs;
    this.dSmooth = this.dTarget;
    this.setWow(30);
    this.setSaturation(40);
  }

  setTime(ms: number): void {
    const v = Math.min(TAPE_TIME_MAX_MS, Math.max(TAPE_TIME_MIN_MS, ms));
    this.dTarget = (v / 1000) * this.fsOs;
  }

  setFeedback(pct: number): void {
    this.fbGain = Math.min(110, Math.max(0, pct)) / 100;
  }

  setWow(v: number): void {
    const k = Math.min(100, Math.max(0, v)) / 100;
    this.wowAmpOs = k * TAPE_WOW_MAX_S * this.fsOs;
    this.flAmpOs = k * TAPE_FLUTTER_MAX_S * this.fsOs;
  }

  setSaturation(v: number): void {
    const k = Math.min(100, Math.max(0, v)) / 100;
    this.kneeRec = 2 * Math.pow(0.125, k); // 2.0 → 0.25
    this.kneeLoop = 1.1 - 0.75 * k; // 1.1 → 0.35
  }

  setMix(pct: number): void {
    this.wetGain = Math.min(100, Math.max(0, pct)) / 100;
  }

  process(x: number): number {
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
