import type { CabIrRef } from './cabIrTypes';

export interface StoredCabIr {
  hash: string;
  name: string;
  blob: Blob;
  bytes: number;
  channels: 1 | 2;
  originalSampleRate: number;
  processedSampleRate: number;
  durationSeconds: number;
  trimmedFrames: number;
  createdAt: number;
  lastUsedAt: number;
}

export interface CabIrLibraryPort {
  get(hash: string): Promise<StoredCabIr | null>;
  put(record: StoredCabIr): Promise<CabIrPersistReceipt | void>;
  touch(hash: string): Promise<void>;
}

export interface CabIrPersistReceipt {
  /** 激活/提交在持久化后失败时，恢复插入前的库内容与 LRU 淘汰项。 */
  rollback(): Promise<void>;
}

export interface CabIrRuntimePort {
  prepare(ref: CabIrRef, source?: unknown): Promise<unknown>;
  /** prepare 已完成后必须是同步、不可失败的原子听感切换。 */
  activate(prepared: unknown, canonicalRef?: CabIrRef): void;
}

export type CabIrSelectionResult =
  | { ok: true; ref: CabIrRef }
  | { ok: false; reason: 'missing' | 'failed' | 'superseded'; message: string };

export type CabIrRestoreResult =
  | { ok: true; ref: CabIrRef; fallback: boolean }
  | { ok: false; reason: 'failed' | 'superseded'; message: string };

export interface CabIrCoordinatorOptions {
  library: CabIrLibraryPort;
  runtime: CabIrRuntimePort;
  commit(ref: CabIrRef): void;
}

/**
 * Cab 选择事务的唯一编排 seam：prepare/persist 全成功后才 activate + canonical commit。
 * generation 防止迟到的 decode/IDB 操作覆盖用户更新的选择。
 */
export class CabIrCoordinator {
  private generation = 0;
  private readonly options: CabIrCoordinatorOptions;
  private commitBarrier: Promise<void> = Promise.resolve();

  constructor(options: CabIrCoordinatorOptions) {
    this.options = options;
  }

  async supersede(): Promise<void> {
    await this.commitBarrier;
    this.generation++;
  }

  private async begin(): Promise<number> {
    // 已进入 IDB commit 的事务不可被新意图从中间撕开；新意图在其原子提交后继续。
    await this.commitBarrier;
    return ++this.generation;
  }

  private async finalize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.commitBarrier;
    let release = () => {};
    this.commitBarrier = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async select(ref: CabIrRef): Promise<CabIrSelectionResult> {
    const generation = await this.begin();
    try {
      let source: StoredCabIr | undefined;
      if (ref.kind === 'custom') {
        source = (await this.options.library.get(ref.hash)) ?? undefined;
        if (!source) {
          return { ok: false, reason: 'missing', message: 'IR 缺失，请重新导入原文件。' };
        }
      }
      const prepared = await this.options.runtime.prepare(ref, source);
      if (generation !== this.generation) {
        return { ok: false, reason: 'superseded', message: '已选择更新的箱体 IR。' };
      }
      await this.finalize(async () => {
        if (generation !== this.generation) throw new SupersededCabIrSelection();
        this.options.runtime.activate(prepared);
        this.options.commit(ref);
      });
      if (ref.kind === 'custom') void this.options.library.touch(ref.hash);
      return { ok: true, ref };
    } catch (error) {
      if (error instanceof SupersededCabIrSelection) {
        return { ok: false, reason: 'superseded', message: '已选择更新的箱体 IR。' };
      }
      return {
        ok: false,
        reason: 'failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 整 Rig 恢复事务：IR 可用时先 prepare，随后在同一提交屏障内切换听感并提交整套 Rig。
   * 自定义 hash 缺失时保留 canonical 目标，以内置 Greenback 作为仅运行时回退。
   */
  async restore(ref: CabIrRef, commitRig: () => void): Promise<CabIrRestoreResult> {
    const generation = await this.begin();
    try {
      let source: StoredCabIr | undefined;
      let audibleRef = ref;
      let fallback = false;
      if (ref.kind === 'custom') {
        source = (await this.options.library.get(ref.hash)) ?? undefined;
        if (!source) {
          audibleRef = { kind: 'builtin', id: 'gb4x12' };
          fallback = true;
        }
      }
      const prepared = await this.options.runtime.prepare(audibleRef, source);
      if (generation !== this.generation) {
        return { ok: false, reason: 'superseded', message: '已恢复更新的 Rig。' };
      }
      await this.finalize(async () => {
        if (generation !== this.generation) throw new SupersededCabIrSelection();
        this.options.runtime.activate(prepared, ref);
        commitRig();
      });
      if (ref.kind === 'custom' && !fallback) void this.options.library.touch(ref.hash);
      return { ok: true, ref, fallback };
    } catch (error) {
      if (error instanceof SupersededCabIrSelection) {
        return { ok: false, reason: 'superseded', message: '已恢复更新的 Rig。' };
      }
      return {
        ok: false,
        reason: 'failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async importPrepared(record: StoredCabIr, decoded: unknown): Promise<CabIrSelectionResult> {
    const generation = await this.begin();
    const ref: CabIrRef = { kind: 'custom', hash: record.hash };
    try {
      const prepared = await this.options.runtime.prepare(ref, { record, decoded });
      if (generation !== this.generation) {
        return { ok: false, reason: 'superseded', message: '已选择更新的箱体 IR。' };
      }
      await this.finalize(async () => {
        if (generation !== this.generation) throw new SupersededCabIrSelection();
        const receipt = await this.options.library.put(record);
        try {
          // begin() 会等待 commitBarrier，故 put 期间 generation 不可能变化。
          this.options.runtime.activate(prepared);
          this.options.commit(ref);
        } catch (error) {
          await receipt?.rollback();
          throw error;
        }
      });
      return { ok: true, ref };
    } catch (error) {
      if (error instanceof SupersededCabIrSelection) {
        return { ok: false, reason: 'superseded', message: '已选择更新的箱体 IR。' };
      }
      return {
        ok: false,
        reason: 'failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

class SupersededCabIrSelection extends Error {}
