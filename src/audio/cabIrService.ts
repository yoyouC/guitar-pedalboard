import { audioEngine, type AudioEngine } from './AudioEngine';
import {
  CabIrCoordinator,
  type CabIrSelectionResult,
  type StoredCabIr,
} from './cabIrCoordinator';
import {
  BrowserCabIrLibrary,
  UnavailableCabIrLibrary,
  type CabIrLibraryStore,
} from './cabIrLibrary';
import {
  MAX_CAB_IR_BYTES,
  calibrateCustomCabIr,
  inspectWav,
  preprocessCabIr,
  sha256Hex,
} from './cabIrProcessing';
import type { CabIrRef } from './cabIrTypes';
import {
  customIrReferenceLabels,
  referencedCustomIrHashes,
  type ApplyRigState,
  type LoadPresetResult,
  type RigStore,
} from '../state/rigStore';
import { rigStore } from '../state/useRig';

export type CabIrUiStatus = 'idle' | 'loading' | 'ready' | 'missing' | 'error';

export interface CabIrServiceState {
  status: CabIrUiStatus;
  message: string | null;
  library: StoredCabIr[];
  active: StoredCabIr | null;
}

export class CabIrService {
  private state: CabIrServiceState = {
    status: 'idle', message: null, library: [], active: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly libraryStore: CabIrLibraryStore;
  private readonly coordinator: CabIrCoordinator;
  private readonly engine: AudioEngine;
  private readonly rig: RigStore;

  constructor(engine: AudioEngine, rig: RigStore, library?: CabIrLibraryStore) {
    this.engine = engine;
    this.rig = rig;
    this.libraryStore = library ?? new BrowserCabIrLibrary({
      pinnedHashes: () => referencedCustomIrHashes(this.rig.getState()),
    });
    this.engine.setCabIrCustomLoader(
      (hash) => this.libraryStore.get(hash),
      (hash, calibrationDb) => this.libraryStore.setCalibration(hash, calibrationDb),
    );
    this.coordinator = new CabIrCoordinator({
      library: this.libraryStore,
      runtime: {
        prepare: (ref, source) => this.engine.prepareCabIr(ref, source),
        activate: (prepared, canonicalRef) => this.engine.activatePreparedCabIr(
          prepared as Awaited<ReturnType<AudioEngine['prepareCabIr']>>,
          canonicalRef,
        ),
      },
      commit: (ref) => this.rig.commitCabIr(ref),
    });
    this.rig.setRigRestoreHandler((nextRig, commit) => this.restoreRig(nextRig, commit));
  }

  getState = (): CabIrServiceState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<CabIrServiceState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  async refresh(): Promise<void> {
    const records = await this.libraryStore.list();
    const activeRef = this.rig.getState().cabIrRef;
    const active = activeRef.kind === 'custom'
      ? records.find((record) => record.hash === activeRef.hash) ?? null
      : null;
    this.update({
      library: records,
      active,
      status: activeRef.kind === 'custom' ? (active ? 'ready' : 'missing') : 'idle',
      message: activeRef.kind === 'custom' && !active ? 'IR 缺失，请重新导入原文件。' : null,
    });
  }

  async select(ref: CabIrRef): Promise<CabIrSelectionResult> {
    this.update({ status: 'loading', message: null });
    const result = await this.coordinator.select(ref);
    await this.refresh();
    if (!result.ok) this.update({ status: result.reason === 'missing' ? 'missing' : 'error', message: result.message });
    else this.update({ status: 'ready', message: null });
    return result;
  }

  private async restoreRig(
    nextRig: ApplyRigState,
    commit: () => void,
  ): Promise<LoadPresetResult> {
    this.update({ status: 'loading', message: null });
    const result = await this.coordinator.restore(nextRig.cab.ir, commit);
    if (!result.ok) {
      this.update({ status: 'error', message: result.message });
      return { ok: false, message: result.message };
    }
    await this.refresh();
    if (!result.fallback) this.update({ status: 'ready', message: null });
    return { ok: true };
  }

  async importFile(file: File): Promise<CabIrSelectionResult> {
    this.update({ status: 'loading', message: null });
    try {
      if (file.size <= 0 || file.size > MAX_CAB_IR_BYTES) throw new Error('WAV 文件必须小于或等于 10MB');
      const bytes = await file.arrayBuffer();
      const wav = inspectWav(bytes);
      const hash = await sha256Hex(bytes);
      const existing = await this.libraryStore.get(hash);
      if (existing) return await this.select({ kind: 'custom', hash });
      const ctx = this.engine.ctx;
      if (!ctx) throw new Error('请先启动音频输入再导入 IR');
      const decoded = await ctx.decodeAudioData(bytes.slice(0));
      const processed = preprocessCabIr(decoded);
      const calibration = calibrateCustomCabIr(processed);
      const now = Date.now();
      const record: StoredCabIr = {
        hash,
        name: file.name.trim() || 'Custom IR.wav',
        blob: file.slice(0, file.size, 'audio/wav'),
        bytes: file.size,
        channels: wav.channels as 1 | 2,
        originalSampleRate: wav.sampleRate,
        processedSampleRate: processed.sampleRate,
        durationSeconds: processed.durationSeconds,
        trimmedFrames: processed.trimmedFrames,
        calibrationDb: calibration.calibrationDb,
        createdAt: now,
        lastUsedAt: now,
      };
      const result = await this.coordinator.importPrepared(record, processed);
      await this.refresh();
      if (!result.ok) this.update({ status: 'error', message: result.message });
      else this.update({ status: 'ready', message: null, active: record });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.update({ status: 'error', message });
      return { ok: false, reason: 'failed', message };
    }
  }

  async delete(hash: string): Promise<boolean> {
    const references = customIrReferenceLabels(this.rig.getState(), hash);
    if (references.length > 0) {
      this.update({
        status: 'error',
        message: `该 IR 正被以下位置引用，无法删除：${references.join('、')}。`,
      });
      return false;
    }
    const deleted = await this.libraryStore.delete(hash);
    if (!deleted) {
      this.update({ status: 'error', message: '该 IR 正被当前 Rig、预设或快照引用，无法删除。' });
      return false;
    }
    await this.refresh();
    return true;
  }
}

export const cabIrService = new CabIrService(
  audioEngine,
  rigStore,
  typeof indexedDB === 'undefined' ? new UnavailableCabIrLibrary() : undefined,
);
