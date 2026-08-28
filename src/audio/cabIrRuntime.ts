import type { EffectDefinition } from './effects/types';
import { LEVEL_DB_MAX, LEVEL_DB_MIN } from './level';
import { createCabIrEffect, type CabIrEffectInstance } from './cabIrEffect';
import { BUILTIN_CAB_IR_MANIFEST } from './cabIrManifest';
import { inspectWav, preprocessCabIr, sha256Hex, type ProcessedCabIr } from './cabIrProcessing';
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

export function stageInitialCabIrBuffer(
  ctx: AudioContext,
  buffer: AudioBuffer,
  calibrationDb = 0,
): void {
  initialBuffers.set(ctx, { buffer, calibrationDb });
}

export function cabIrCalibrationDb(ref: CabIrRef): number {
  if (ref.kind === 'custom') return 0;
  const entry = BUILTIN_CAB_IR_MANIFEST.find((candidate) => candidate.id === ref.id);
  if (!entry || !Number.isFinite(entry.calibrationDb)) {
    throw new Error(`内置箱体 IR 缺少校准数据：${ref.id}`);
  }
  return entry.calibrationDb;
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
      step: 0.5, defaultValue: -6, unit: 'dB',
    },
  ],
  create(ctx) {
    const initial = initialBuffers.get(ctx);
    if (!initial) throw new Error('箱体 IR Runtime 未完成准备');
    return createCabIrEffect(ctx, initial.buffer, -6, initial.calibrationDb);
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

async function decodeWav(ctx: AudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  inspectWav(bytes);
  const decoded = await ctx.decodeAudioData(bytes.slice(0));
  return processedToAudioBuffer(ctx, preprocessCabIr(decoded));
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
  private readonly caches = new WeakMap<AudioContext, Map<string, AudioBuffer>>();
  private customLoader: ((hash: string) => Promise<StoredCabIr | null>) | null = null;

  setCustomLoader(loader: (hash: string) => Promise<StoredCabIr | null>): void {
    this.customLoader = loader;
  }

  async resolve(ctx: AudioContext, ref: CabIrRef, source?: unknown): Promise<AudioBuffer> {
    let cache = this.caches.get(ctx);
    if (!cache) {
      cache = new Map();
      this.caches.set(ctx, cache);
    }
    const key = cabIrRefKey(ref);
    const cached = cache.get(key);
    if (cached) return cached;

    let buffer: AudioBuffer;
    if (isImportPreparedSource(source)) {
      buffer = processedToAudioBuffer(ctx, source.decoded);
    } else if (ref.kind === 'custom') {
      const record = (source as StoredCabIr | undefined) ?? await this.customLoader?.(ref.hash) ?? undefined;
      if (!record || record.hash !== ref.hash) throw new Error('IR 缺失，请重新导入原文件');
      const bytes = await record.blob.arrayBuffer();
      if (await sha256Hex(bytes) !== ref.hash) throw new Error('本地 IR 完整性校验失败，请重新导入');
      buffer = await decodeWav(ctx, bytes);
    } else {
      const entry = BUILTIN_CAB_IR_MANIFEST.find((candidate) => candidate.id === ref.id);
      if (!entry?.approved) throw new Error(`内置箱体 IR 尚未获准发布：${ref.id}`);
      const response = await fetch(entry.url);
      if (!response.ok) throw new Error(`箱体 IR 下载失败 (${response.status})`);
      const bytes = await response.arrayBuffer();
      if (entry.sha256 && await sha256Hex(bytes) !== entry.sha256) {
        throw new Error(`箱体 IR 完整性校验失败：${ref.id}`);
      }
      buffer = await decodeWav(ctx, bytes);
    }
    cache.set(key, buffer);
    return buffer;
  }
}
