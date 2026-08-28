export const MAX_CAB_IR_BYTES = 10 * 1024 * 1024;
export const MAX_CAB_IR_SECONDS = 2;
export const CUSTOM_CAB_IR_TARGET_TRANSFER_DB = 1.8;
export const CUSTOM_CAB_IR_CALIBRATION_DB_MIN = -24;
export const CUSTOM_CAB_IR_CALIBRATION_DB_MAX = 12;
export const CUSTOM_CAB_IR_MAX_CALIBRATED_PEAK = 1;
const SILENCE_THRESHOLD_DB = -80;
const PREROLL_SECONDS = 0.0005;
const CALIBRATION_FREQUENCY_MIN_HZ = 70;
const CALIBRATION_FREQUENCY_MAX_HZ = 10_000;
const CALIBRATION_FREQUENCY_LINES = 1024;

export class CabIrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CabIrError';
  }
}

export interface WavMetadata {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  audioFormat: number;
}

export interface DecodedCabIr {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  duration: number;
  getChannelData(channel: number): Float32Array;
}

export interface ProcessedCabIr {
  channels: Float32Array[];
  sampleRate: number;
  durationSeconds: number;
  trimmedFrames: number;
  peak: number;
}

export interface CabIrCalibration {
  rawTransferDb: number;
  calibrationDb: number;
  calibratedTransferDb: number;
  calibratedPeak: number;
  limited: boolean;
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

/** 原地 radix-2 FFT；正向变换不缩放，幅度与直接 DFT 保持一致。 */
function fft(real: Float64Array, imaginary: Float64Array): void {
  const size = real.length;
  for (let index = 1, reversed = 0; index < size; index++) {
    let bit = size >> 1;
    while (reversed & bit) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
    if (index >= reversed) continue;
    [real[index], real[reversed]] = [real[reversed], real[index]];
    [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
  }

  for (let width = 2; width <= size; width *= 2) {
    const angle = -2 * Math.PI / width;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let offset = 0; offset < size; offset += width) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let lane = 0; lane < width / 2; lane++) {
        const even = offset + lane;
        const odd = even + width / 2;
        const oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
        const oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
}

/**
 * 与内置资产基线相同的 70Hz–10kHz、1024 点 pink-power 加权传递增益。
 * FFT 只在导入/首次迁移时运行，不进入实时音频线程。
 */
export function pinkWeightedCabIrTransferDb(processed: ProcessedCabIr): number {
  const fftSize = nextPowerOfTwo(processed.channels[0].length);
  const spectra = processed.channels.map((channel) => {
    const real = new Float64Array(fftSize);
    const imaginary = new Float64Array(fftSize);
    real.set(channel);
    fft(real, imaginary);
    return { real, imaginary };
  });
  let weightedPower = 0;
  let weightSum = 0;
  for (let line = 0; line < CALIBRATION_FREQUENCY_LINES; line++) {
    const frequency = CALIBRATION_FREQUENCY_MIN_HZ
      + (CALIBRATION_FREQUENCY_MAX_HZ - CALIBRATION_FREQUENCY_MIN_HZ)
        * line / (CALIBRATION_FREQUENCY_LINES - 1);
    const exactBin = frequency * fftSize / processed.sampleRate;
    const lowerBin = Math.floor(exactBin);
    const upperBin = Math.min(lowerBin + 1, fftSize / 2);
    const mix = exactBin - lowerBin;
    let power = 0;
    for (const spectrum of spectra) {
      const real = spectrum.real[lowerBin] * (1 - mix) + spectrum.real[upperBin] * mix;
      const imaginary = spectrum.imaginary[lowerBin] * (1 - mix)
        + spectrum.imaginary[upperBin] * mix;
      power += real * real + imaginary * imaginary;
    }
    power /= spectra.length;
    const weight = 1 / frequency;
    weightedPower += power * weight;
    weightSum += weight;
  }
  const transferDb = 10 * Math.log10(weightedPower / weightSum);
  if (!Number.isFinite(transferDb)) throw new CabIrError('无法计算箱体 IR 的自动校准');
  return transferDb;
}

/** 计算一次性资产增益；不改写 PCM，也不会在演奏期间追踪或压缩响度。 */
export function calibrateCustomCabIr(processed: ProcessedCabIr): CabIrCalibration {
  const rawTransferDb = pinkWeightedCabIrTransferDb(processed);
  const requestedDb = CUSTOM_CAB_IR_TARGET_TRANSFER_DB - rawTransferDb;
  const rangeLimitedDb = Math.max(
    CUSTOM_CAB_IR_CALIBRATION_DB_MIN,
    Math.min(CUSTOM_CAB_IR_CALIBRATION_DB_MAX, requestedDb),
  );
  const peakLimitedDb = 20 * Math.log10(CUSTOM_CAB_IR_MAX_CALIBRATED_PEAK / processed.peak);
  if (peakLimitedDb < CUSTOM_CAB_IR_CALIBRATION_DB_MIN) {
    throw new CabIrError('箱体 IR 峰值过高，无法在安全增益范围内校准');
  }
  const calibrationDb = Math.round(Math.min(rangeLimitedDb, peakLimitedDb) * 1000) / 1000;
  return {
    rawTransferDb,
    calibrationDb,
    calibratedTransferDb: rawTransferDb + calibrationDb,
    calibratedPeak: processed.peak * 10 ** (calibrationDb / 20),
    limited: Math.abs(calibrationDb - requestedDb) > 0.0005,
  };
}

function fourCc(view: DataView, offset: number): string {
  if (offset + 4 > view.byteLength) return '';
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/** 只解析原始 WAV 容器元数据；实际 PCM/float 解码交给当前 AudioContext。 */
export function inspectWav(bytes: ArrayBuffer): WavMetadata {
  if (bytes.byteLength < 12) throw new CabIrError('文件不是有效的 WAV');
  const view = new DataView(bytes);
  if (fourCc(view, 0) !== 'RIFF' || fourCc(view, 8) !== 'WAVE') {
    throw new CabIrError('仅支持 RIFF/WAVE 文件');
  }
  let offset = 12;
  let metadata: WavMetadata | null = null;
  let hasData = false;
  while (offset + 8 <= view.byteLength) {
    const id = fourCc(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > view.byteLength) throw new CabIrError('WAV chunk 长度无效');
    if (id === 'fmt ') {
      if (size < 16) throw new CabIrError('WAV fmt chunk 无效');
      metadata = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      hasData = size > 0;
    }
    offset = body + size + (size & 1);
  }
  if (!metadata || !hasData) throw new CabIrError('WAV 缺少 fmt 或 audio data');
  if (metadata.channels !== 1 && metadata.channels !== 2) {
    throw new CabIrError('箱体 IR 必须是单声道或双声道');
  }
  if (!Number.isFinite(metadata.sampleRate) || metadata.sampleRate <= 0) {
    throw new CabIrError('WAV 采样率无效');
  }
  return metadata;
}

/** 校验 decodeAudioData 的结果并按跨声道共同起点裁掉前导静音。 */
export function preprocessCabIr(decoded: DecodedCabIr): ProcessedCabIr {
  if (decoded.numberOfChannels !== 1 && decoded.numberOfChannels !== 2) {
    throw new CabIrError('箱体 IR 必须解码为单声道或双声道');
  }
  if (
    !Number.isFinite(decoded.sampleRate) ||
    decoded.sampleRate <= 0 ||
    !Number.isFinite(decoded.duration) ||
    decoded.duration <= 0 ||
    decoded.duration > MAX_CAB_IR_SECONDS
  ) {
    throw new CabIrError('箱体 IR 解码后时长必须大于 0 且不超过 2 秒');
  }
  if (!Number.isInteger(decoded.length) || decoded.length <= 0) {
    throw new CabIrError('箱体 IR 没有可用采样');
  }

  const source: Float32Array[] = [];
  let peak = 0;
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const values = decoded.getChannelData(channel);
    if (values.length !== decoded.length) throw new CabIrError('箱体 IR 声道长度不一致');
    source.push(values);
    for (const sample of values) {
      if (!Number.isFinite(sample)) throw new CabIrError('箱体 IR 包含非有限采样');
      peak = Math.max(peak, Math.abs(sample));
    }
  }
  if (peak === 0) throw new CabIrError('箱体 IR 是静音文件');

  const threshold = peak * 10 ** (SILENCE_THRESHOLD_DB / 20);
  let firstActive = 0;
  outer: for (; firstActive < decoded.length; firstActive++) {
    for (const channel of source) {
      if (Math.abs(channel[firstActive]) >= threshold) break outer;
    }
  }
  const prerollFrames = Math.round(decoded.sampleRate * PREROLL_SECONDS);
  const trimmedFrames = Math.max(0, firstActive - prerollFrames);
  const channels = source.map((values) => values.slice(trimmedFrames));
  return {
    channels,
    sampleRate: decoded.sampleRate,
    durationSeconds: channels[0].length / decoded.sampleRate,
    trimmedFrames,
    peak,
  };
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
