import type { AudioProfile } from './audioProfile';

export interface LoopbackAnalysis {
  ok: boolean;
  delaySamples: number | null;
  delayMs: number | null;
  confidence: number;
  peak: number;
  reason?: 'too-quiet' | 'clipped' | 'ambiguous' | 'invalid';
}

export interface LoopbackCalibrationKey {
  inputDeviceId: string;
  outputDeviceId: string;
  sampleRate: number;
  profile: AudioProfile;
  browserMajor: string;
  osAudioConfig: string;
}

export interface StoredLoopbackCalibration {
  key: LoopbackCalibrationKey;
  delayMs: number;
  confidence: number;
  measuredAt: string;
}

const CALIBRATION_STORAGE_KEY = 'guitar-pedalboard-loopback-calibration-v1';

export function loadLoopbackCalibration(
  storage: Pick<Storage, 'getItem'> | null = safeStorage(),
): StoredLoopbackCalibration | null {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(CALIBRATION_STORAGE_KEY) ?? 'null') as StoredLoopbackCalibration | null;
    if (!value || typeof value.delayMs !== 'number' || typeof value.confidence !== 'number' || !value.key) return null;
    return value;
  } catch {
    return null;
  }
}

export function saveLoopbackCalibration(
  calibration: StoredLoopbackCalibration,
  storage: Pick<Storage, 'setItem'> | null = safeStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(calibration));
  } catch {
    /* 存储不可用时，本次会话内仍可使用校准值 */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 可重复的 256-sample ±1 序列；幅度由播放端控制。 */
export function createLoopbackSequence(length = 256): Float32Array {
  const sequence = new Float32Array(length);
  let state = 0x5a17;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    sequence[i] = state & 1 ? 1 : -1;
  }
  return sequence;
}

/**
 * 归一化互相关寻找回环峰值。序列很短，允许在主线程一次性分析约 1 秒录音。
 * 低电平、削波或双峰不生成“往返时延”。
 */
export function analyzeLoopback(
  captured: Float32Array,
  reference: Float32Array,
  sampleRate: number,
): LoopbackAnalysis {
  if (captured.length < reference.length || reference.length < 8 || sampleRate <= 0) {
    return { ok: false, delaySamples: null, delayMs: null, confidence: 0, peak: 0, reason: 'invalid' };
  }
  let capturedPeak = 0;
  let capturedEnergy = 0;
  for (const value of captured) {
    const abs = Math.abs(value);
    capturedPeak = Math.max(capturedPeak, abs);
    capturedEnergy += value * value;
  }
  const rms = Math.sqrt(capturedEnergy / captured.length);
  if (capturedPeak >= 0.995) {
    return { ok: false, delaySamples: null, delayMs: null, confidence: 0, peak: capturedPeak, reason: 'clipped' };
  }
  if (rms < 0.0005) {
    return { ok: false, delaySamples: null, delayMs: null, confidence: 0, peak: capturedPeak, reason: 'too-quiet' };
  }

  let refEnergy = 0;
  for (const value of reference) refEnergy += value * value;
  let best = -Infinity;
  let second = -Infinity;
  let bestLag = 0;
  const scores = new Float64Array(captured.length - reference.length + 1);
  for (let lag = 0; lag <= captured.length - reference.length; lag++) {
    let dot = 0;
    let windowEnergy = 0;
    for (let i = 0; i < reference.length; i++) {
      const sample = captured[lag + i];
      dot += sample * reference[i];
      windowEnergy += sample * sample;
    }
    const score = windowEnergy > 0 ? dot / Math.sqrt(windowEnergy * refEnergy) : 0;
    scores[lag] = score;
    if (score > best) {
      second = best;
      best = score;
      bestLag = lag;
    } else if (score > second && Math.abs(lag - bestLag) > reference.length) {
      second = score;
    }
  }
  const separation = best - Math.max(0, second);
  const confidence = Math.max(0, Math.min(1, best * Math.min(1, separation / 0.15)));
  if (best < 0.45 || separation < 0.08) {
    return { ok: false, delaySamples: null, delayMs: null, confidence, peak: best, reason: 'ambiguous' };
  }
  let fractionalOffset = 0;
  if (bestLag > 0 && bestLag < scores.length - 1) {
    const left = scores[bestLag - 1];
    const center = scores[bestLag];
    const right = scores[bestLag + 1];
    const denominator = left - 2 * center + right;
    if (Math.abs(denominator) > 1e-9) {
      fractionalOffset = Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / denominator));
    }
  }
  const delaySamples = bestLag + fractionalOffset;
  return {
    ok: true,
    delaySamples,
    delayMs: (delaySamples / sampleRate) * 1000,
    confidence,
    peak: best,
  };
}

export function calibrationMatches(
  calibration: StoredLoopbackCalibration | null,
  key: LoopbackCalibrationKey,
): boolean {
  return calibration !== null && JSON.stringify(calibration.key) === JSON.stringify(key);
}
