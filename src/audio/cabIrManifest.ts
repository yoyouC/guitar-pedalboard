import type { BuiltinCabId } from './cabIrTypes';
import rawManifest from '../../public/irs/manifest.json';

export interface BuiltinCabIrManifestEntry {
  id: BuiltinCabId;
  name: string;
  file: string;
  url: string;
  sha256: string | null;
  sourceUrl: string | null;
  license: string | null;
  attribution: string | null;
  captureDescription: string | null;
  channels: 1 | 2;
  sampleRate: number;
  bitsPerSample: number;
  durationSeconds: number;
  trimmedFrames: number;
  calibrationDb: number;
  approved: boolean;
}

/**
 * 发布清单。四个资产必须同时批准且元数据完整，生产才能暴露 IR 工作流。
 */
export const BUILTIN_CAB_IR_MANIFEST = rawManifest.entries as readonly BuiltinCabIrManifestEntry[];

export const CAB_IR_ASSETS_READY = BUILTIN_CAB_IR_MANIFEST.every(
  (entry) =>
    entry.approved &&
    entry.sha256 !== null &&
    entry.sourceUrl !== null &&
    entry.license !== null &&
    entry.attribution !== null &&
    entry.captureDescription !== null &&
    (entry.channels === 1 || entry.channels === 2) &&
    Number.isFinite(entry.sampleRate) &&
    Number.isFinite(entry.bitsPerSample) &&
    Number.isFinite(entry.durationSeconds) &&
    Number.isFinite(entry.trimmedFrames) &&
    Number.isFinite(entry.calibrationDb),
);
