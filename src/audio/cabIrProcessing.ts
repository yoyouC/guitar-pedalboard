export const MAX_CAB_IR_BYTES = 10 * 1024 * 1024;
export const MAX_CAB_IR_SECONDS = 2;
const SILENCE_THRESHOLD_DB = -80;
const PREROLL_SECONDS = 0.0005;

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
