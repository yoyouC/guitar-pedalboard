import type { EffectDefinition } from './effects/types';
import { LEVEL_DB_MAX, LEVEL_DB_MIN } from './level';
import { createCabIrEffect, type CabIrEffectInstance } from './cabIrEffect';
import {
  CUSTOM_CAB_IR_CALIBRATION_DB_MAX,
  CUSTOM_CAB_IR_CALIBRATION_DB_MIN,
  calibrateCustomCabIr,
  inspectWav,
  preprocessCabIr,
  sha256Hex,
  type ProcessedCabIr,
} from './cabIrProcessing';
import type { StoredCabIr } from './cabIrCoordinator';
import { cabIrRefKey, type CabIrRef } from './cabIrTypes';

interface StagedCabIrBuffer {
  buffer: AudioBuffer;
  calibrationDb: number;
}

const initialBuffers = new WeakMap<AudioContext, StagedCabIrBuffer>();

export interface PreparedCabIrBuffer {
  context: AudioContext;
  ref: CabIrRef;
  buffer: AudioBuffer;
  calibrationDb: number;
}

interface ResolvedCabIrBuffer {
  buffer: AudioBuffer;
  calibrationDb: number;
}

export function stageInitialCabIrBuffer(
  ctx: AudioContext,
  buffer: AudioBuffer,
  calibrationDb = 0,
): void {
  initialBuffers.set(ctx, { buffer, calibrationDb });
}

export function isCabIrEffectInstance(value: unknown): value is CabIrEffectInstance {
  return typeof (value as { switchBuffer?: unknown } | null)?.switchBuffer === 'function';
}

export const CAB_IR_RUNTIME_DEF: EffectDefinition = {
  id: 'cabIrRuntime',
  name: 'Cabinet IR',
  color: '#5d6d7e',
  params: [
    {
      key: 'level', label: 'LEVEL', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX,
      step: 0.5, defaultValue: -2, unit: 'dB',
    },
  ],
  create(ctx) {
    const initial = initialBuffers.get(ctx);
    if (!initial) throw new Error('箱体 IR Runtime 未完成准备');
    return createCabIrEffect(ctx, initial.buffer, -2, initial.calibrationDb);
  },
};

function processedToAudioBuffer(ctx: AudioContext, processed: ProcessedCabIr): AudioBuffer {
  const buffer = ctx.createBuffer(
    processed.channels.length,
    processed.channels[0].length,
    processed.sampleRate,
  );
  for (let channel = 0; channel < processed.channels.length; channel++) {
    buffer.getChannelData(channel).set(processed.channels[channel]);
  }
  return buffer;
}

async function decodeWav(
  ctx: AudioContext,
  bytes: ArrayBuffer,
): Promise<{ buffer: AudioBuffer; processed: ProcessedCabIr }> {
  inspectWav(bytes);
  const decoded = await ctx.decodeAudioData(bytes.slice(0));
  const processed = preprocessCabIr(decoded);
  return { buffer: processedToAudioBuffer(ctx, processed), processed };
}

interface ImportPreparedSource {
  record: StoredCabIr;
  decoded: ProcessedCabIr;
}

function isImportPreparedSource(value: unknown): value is ImportPreparedSource {
  const source = value as Partial<ImportPreparedSource> | null;
  return Boolean(source?.record && source?.decoded && Array.isArray(source.decoded.channels));
}

/** 每个 AudioContext 独立 lazy cache；原始 Blob 仍由 IR Library 保留。 */
export class CabIrBufferResolver {
  private readonly caches = new WeakMap<AudioContext, Map<string, ResolvedCabIrBuffer>>();
  private customLoader: ((hash: string) => Promise<StoredCabIr | null>) | null = null;
  private customCalibrationSaver: ((hash: string, calibrationDb: number) => Promise<void>) | null = null;

  setCustomLoader(
    loader: (hash: string) => Promise<StoredCabIr | null>,
    saveCalibration?: (hash: string, calibrationDb: number) => Promise<void>,
  ): void {
    this.customLoader = loader;
    this.customCalibrationSaver = saveCalibration ?? null;
  }

  async resolve(ctx: AudioContext, ref: CabIrRef, source?: unknown): Promise<ResolvedCabIrBuffer> {
    let cache = this.caches.get(ctx);
    if (!cache) {
      cache = new Map();
      this.caches.set(ctx, cache);
    }
    const key = cabIrRefKey(ref);
    const cached = cache.get(key);
    if (cached) return cached;

    let resolved: ResolvedCabIrBuffer;
    if (isImportPreparedSource(source)) {
      const calibrationDb = validCustomCalibrationDb(source.record.calibrationDb)
        ? source.record.calibrationDb
        : calibrateCustomCabIr(source.decoded).calibrationDb;
      resolved = { buffer: processedToAudioBuffer(ctx, source.decoded), calibrationDb };
    } else if (ref.kind === 'custom') {
      const record = (source as StoredCabIr | undefined) ?? await this.customLoader?.(ref.hash) ?? undefined;
      if (!record || record.hash !== ref.hash) throw new Error('IR 缺失，请重新导入原文件');
      const bytes = await record.blob.arrayBuffer();
      if (await sha256Hex(bytes) !== ref.hash) throw new Error('本地 IR 完整性校验失败，请重新导入');
      const decoded = await decodeWav(ctx, bytes);
      const calibrationDb = validCustomCalibrationDb(record.calibrationDb)
        ? record.calibrationDb
        : calibrateCustomCabIr(decoded.processed).calibrationDb;
      resolved = { buffer: decoded.buffer, calibrationDb };
      if (!validCustomCalibrationDb(record.calibrationDb)) {
        try {
          await this.customCalibrationSaver?.(ref.hash, calibrationDb);
        } catch (error) {
          console.warn('无法写回 Custom IR 自动校准，下次加载时将重新计算:', error);
        }
      }
    } else {
      throw new Error('内置箱体使用 DSP，不加载卷积 IR');
    }
    cache.set(key, resolved);
    return resolved;
  }
}

function validCustomCalibrationDb(value: number | undefined): value is number {
  return Number.isFinite(value)
    && value! >= CUSTOM_CAB_IR_CALIBRATION_DB_MIN
    && value! <= CUSTOM_CAB_IR_CALIBRATION_DB_MAX;
}
