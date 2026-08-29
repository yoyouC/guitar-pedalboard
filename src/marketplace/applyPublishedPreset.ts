import type {
  MarketplaceMemberSummary,
  PublishedPresetRevision,
} from '../../shared/marketplace';
import { isPublishedPresetRevisionCompatible } from '../../shared/marketplaceValidation';
import type { RigProvenance } from '../state/presetCodec';
import { RIG_PRESET_VERSION } from '../state/presetCodec';
import {
  rigFromPreset,
  rigToApplyState,
  type ApplyRigState,
  type LoadPresetResult,
  type RigStore,
} from '../state/rigStore';

const SESSION_KEY = 'guitar-pedalboard:tone-session:v1';

export interface ApplicablePublishedPreset {
  id: string;
  title: string;
  creator: MarketplaceMemberSummary;
  updatedAt: string;
  currentRevision: PublishedPresetRevision;
}

export interface ToneSessionState {
  tone: null | {
    id: string;
    title: string;
    creator: MarketplaceMemberSummary;
    revisionId: string;
  };
  modified: boolean;
  canReturnToOriginal: boolean;
}

interface RestorePoint {
  rig: ApplyRigState;
  provenance: RigProvenance | null;
}

interface PersistedToneSession {
  version: 1;
  original: RestorePoint;
  appliedRig: ApplyRigState;
  tone: NonNullable<ToneSessionState['tone']>;
}

interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PublishedPresetRigSession {
  apply(preset: ApplicablePublishedPreset): Promise<LoadPresetResult>;
  backToOriginal(): Promise<LoadPresetResult>;
  undo(): Promise<LoadPresetResult>;
  exit(): void;
  canUndo(): boolean;
  getState(): ToneSessionState;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

function sameRig(left: ApplyRigState, right: ApplyRigState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function loadPersisted(storage?: SessionStorageLike): PersistedToneSession | null {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(SESSION_KEY) ?? 'null') as Partial<PersistedToneSession> | null;
    return value?.version === 1 && value.original && value.appliedRig && value.tone
      ? value as PersistedToneSession
      : null;
  } catch {
    storage.removeItem(SESSION_KEY);
    return null;
  }
}

export function createPublishedPresetRigSession(
  store: RigStore,
  storage?: SessionStorageLike,
): PublishedPresetRigSession {
  let persisted = loadPersisted(storage);
  const listeners = new Set<() => void>();
  let modified = persisted ? !sameRig(rigToApplyState(store.getState()), persisted.appliedRig) : false;
  let snapshot: ToneSessionState = {
    tone: persisted?.tone ?? null,
    modified,
    canReturnToOriginal: Boolean(persisted),
  };
  const notify = () => {
    snapshot = {
      tone: persisted?.tone ?? null,
      modified,
      canReturnToOriginal: Boolean(persisted),
    };
    listeners.forEach((listener) => listener());
  };
  const save = () => {
    try {
      if (persisted) storage?.setItem(SESSION_KEY, JSON.stringify(persisted));
      else storage?.removeItem(SESSION_KEY);
    } catch { /* session continuity remains available in memory */ }
  };
  const unsubscribeStore = store.subscribe(() => {
    const nextModified = persisted
      ? !sameRig(rigToApplyState(store.getState()), persisted.appliedRig)
      : false;
    if (nextModified === modified) return;
    modified = nextModified;
    notify();
  });

  const backToOriginal = async (): Promise<LoadPresetResult> => {
    if (!persisted) return { ok: false, message: '当前会话没有保存 My Original Rig。' };
    const original = persisted.original;
    try {
      const result = await store.restoreRig(original.rig, original.provenance);
      if (result.ok) {
        persisted = null;
        modified = false;
        save();
        notify();
      }
      return result;
    } catch {
      return { ok: false, message: '暂时无法恢复；My Original Rig 仍保留在当前会话。' };
    }
  };

  return {
    async apply(preset) {
      if (!isPublishedPresetRevisionCompatible(preset.currentRevision)) {
        return { ok: false, message: '当前客户端无法忠实应用这个音色，请升级后再试。' };
      }
      const original = persisted?.original ?? {
        rig: rigToApplyState(store.getState()),
        provenance: store.getState().provenance,
      };
      try {
        const result = await store.restoreRig(
          rigFromPreset({
            version: RIG_PRESET_VERSION,
            name: preset.title,
            rig: preset.currentRevision.rig,
          }),
          {
            presetId: preset.id,
            revisionId: preset.currentRevision.id,
            creatorId: preset.creator.id,
            presetUpdatedAt: preset.updatedAt,
          },
        );
        if (result.ok) {
          persisted = {
            version: 1,
            original,
            appliedRig: rigToApplyState(store.getState()),
            tone: {
              id: preset.id,
              title: preset.title,
              creator: preset.creator,
              revisionId: preset.currentRevision.id,
            },
          };
          modified = false;
          save();
          notify();
        }
        return result;
      } catch {
        return { ok: false, message: '应用过程异常；请检查当前 Rig 后重试。' };
      }
    },
    backToOriginal,
    undo: backToOriginal,
    exit() {
      persisted = null;
      modified = false;
      save();
      notify();
    },
    canUndo() { return Boolean(persisted); },
    getState: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      unsubscribeStore();
      listeners.clear();
    },
  };
}
