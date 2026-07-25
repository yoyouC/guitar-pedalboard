import { useEffect, useState } from 'react';

interface TunerProps {
  analyser: AnalyserNode | null;
}

/** 分析窗口(采样数):analyser 每帧只给 fftSize 个采样,滑动累积成 4096 */
const WINDOW = 4096;
/** 基频搜索范围(Hz),覆盖吉他标准音 E2(82.4Hz) 到 E6(1318Hz 附近泛音区) */
const MIN_FREQ = 60;
const MAX_FREQ = 1300;
/** 静音门限(线性 RMS),低于此值进入待机 */
const RMS_THRESHOLD = 0.008;
/** 置信度门限:自相关峰值 / 零滞后能量,低于此值判定为不可靠(噪声/泛音混乱) */
const CONFIDENCE = 0.3;
/** 偏差在此音分以内视为已校准(指针变绿) */
const IN_TUNE_CENTS = 5;
/** 静音后仍保留上次读数的帧数,避免音符衰减间隙显示闪烁 */
const HOLD_FRAMES = 10;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

interface TunerReading {
  /** false = 待机(无输入或静音) */
  active: boolean;
  note: string;
  octave: number;
  /** 与最近音名的偏差,限制在 ±50 */
  cents: number;
  freq: number;
}

const STANDBY: TunerReading = { active: false, note: '--', octave: 0, cents: 0, freq: 0 };

/**
 * 自相关法测基频:在 [minLag, maxLag] 内找自相关峰,返回 Hz;无法判定返回 0。
 * 以窗口内最新 N 个采样为基准与其历史做相关,兼顾 4096 窗口的稳定性与响应速度。
 */
function detectPitch(
  buf: Float32Array,
  sampleRate: number,
  minLag: number,
  maxLag: number,
  corr: Float32Array,
): number {
  const n = WINDOW >> 1;
  const last = WINDOW - 1;

  // 能量门限 + 零滞后能量(置信度基准),取最新半个窗口
  let r0 = 0;
  for (let i = 0; i < n; i++) r0 += buf[last - i] * buf[last - i];
  if (Math.sqrt(r0 / n) < RMS_THRESHOLD) return 0;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += buf[last - i] * buf[last - i - lag];
    corr[lag] = s;
  }

  // 全局最大峰
  let best = minLag;
  for (let lag = minLag + 1; lag <= maxLag; lag++) {
    if (corr[lag] > corr[best]) best = lag;
  }
  if (corr[best] < r0 * CONFIDENCE) return 0;

  // 取第一个达到全局最大 85% 的局部峰:周期性信号自相关在周期整数倍处都有峰,
  // 直接取全局最大容易误判低八度,第一个足够强的峰才是真周期
  let lag = best;
  for (let l = minLag + 1; l < best; l++) {
    if (corr[l] >= corr[l - 1] && corr[l] >= corr[l + 1] && corr[l] >= corr[best] * 0.85) {
      lag = l;
      break;
    }
  }

  // 抛物线插值求亚采样精度
  const xm = corr[lag - 1];
  const x0 = corr[lag];
  const xp = corr[lag + 1];
  const denom = xm - 2 * x0 + xp;
  const shift = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (xm - xp)) / denom)) : 0;
  return sampleRate / (lag + shift);
}

/** 调音表:读 inputAnalyser 时域数据,自相关测基频,显示音名 + 音分偏差指针条,rAF 刷新 */
export function Tuner({ analyser }: TunerProps) {
  const [reading, setReading] = useState<TunerReading>(STANDBY);

  useEffect(() => {
    if (!analyser) {
      setReading(STANDBY);
      return;
    }
    const sampleRate = analyser.context.sampleRate;
    const minLag = Math.max(2, Math.floor(sampleRate / MAX_FREQ));
    const maxLag = Math.ceil(sampleRate / MIN_FREQ);
    const frame = new Float32Array(analyser.fftSize);
    const buf = new Float32Array(WINDOW);
    const corr = new Float32Array(maxLag + 2);

    let raf = 0;
    let smoothFreq = 0;
    let silentFrames = 0;
    let lastKey = '';

    const tick = () => {
      analyser.getFloatTimeDomainData(frame);
      // 滑窗:丢弃最旧一帧,末尾补入最新采样
      const nf = Math.min(frame.length, WINDOW);
      buf.copyWithin(0, nf);
      buf.set(frame.subarray(0, nf), WINDOW - nf);

      const freq = detectPitch(buf, sampleRate, minLag, maxLag, corr);
      if (freq > 0) {
        silentFrames = 0;
        // 音高跳变(换音)直接吸附,连续变化做平滑,抑制指针抖动
        if (smoothFreq <= 0 || Math.abs(Math.log2(freq / smoothFreq)) > 0.25) {
          smoothFreq = freq;
        } else {
          smoothFreq += (freq - smoothFreq) * 0.35;
        }
        const midi = 69 + 12 * Math.log2(smoothFreq / 440);
        const nearest = Math.round(midi);
        const cents = Math.max(-50, Math.min(50, (midi - nearest) * 100));
        const note = NOTE_NAMES[((nearest % 12) + 12) % 12];
        const octave = Math.floor(nearest / 12) - 1;
        // 显示值未变则跳过一次 setState(指针按整数音分移动)
        const key = `${note}${octave}:${Math.round(cents)}:${Math.round(smoothFreq * 10)}`;
        if (key !== lastKey) {
          lastKey = key;
          setReading({ active: true, note, octave, cents, freq: smoothFreq });
        }
      } else if (silentFrames < HOLD_FRAMES) {
        silentFrames++;
      } else {
        smoothFreq = 0;
        if (lastKey !== 'standby') {
          lastKey = 'standby';
          setReading(STANDBY);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [analyser]);

  const inTune = reading.active && Math.abs(reading.cents) <= IN_TUNE_CENTS;

  return (
    <div className={`tuner-panel ${reading.active ? (inTune ? 'in-tune' : 'off-tune') : 'standby'}`}>
      <div className="tuner-readout">
        <span className="tuner-note">{reading.note}</span>
        <span className="tuner-octave">{reading.active ? reading.octave : ''}</span>
        <span className="tuner-freq">{reading.active ? `${reading.freq.toFixed(1)} Hz` : ''}</span>
      </div>
      <div className="tuner-scale">
        <div className="tuner-track">
          <div className="tuner-center-zone" />
          {reading.active && (
            <div
              className="tuner-needle"
              style={{ left: `${((reading.cents + 50) / 100) * 100}%` }}
            />
          )}
        </div>
        <div className="tuner-ticks">
          <span>-50</span>
          <span>-25</span>
          <span>0</span>
          <span>+25</span>
          <span>+50</span>
        </div>
      </div>
      <div className="tuner-status">
        {reading.active ? (
          <span className="tuner-cents">
            {reading.cents > 0 ? '+' : ''}
            {Math.round(reading.cents)}¢
          </span>
        ) : (
          <span className="tuner-hint">
            {analyser ? '待机 · 弹奏琴弦开始调音' : '请先选择输入源'}
          </span>
        )}
      </div>
    </div>
  );
}
