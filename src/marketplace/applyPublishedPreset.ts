import type { PublishedPreset } from '../../shared/marketplace';
import { RIG_PRESET_VERSION } from '../state/presetCodec';
import {
  rigFromPreset,
  rigToApplyState,
  type ApplyRigState,
  type LoadPresetResult,
  type RigStore,
} from '../state/rigStore';

export interface PublishedPresetRigSession {
  apply(preset: PublishedPreset): Promise<LoadPresetResult>;
  undo(): Promise<LoadPresetResult>;
  canUndo(): boolean;
}

export function createPublishedPresetRigSession(store: RigStore): PublishedPresetRigSession {
  let restorePoint: ApplyRigState | null = null;

  return {
    async apply(preset) {
      if (preset.currentRevision.schemaVersion !== RIG_PRESET_VERSION) {
        return { ok: false, message: '此音色使用了更新版本，请升级应用后再试。' };
      }

      const previousRig = rigToApplyState(store.getState());
      try {
        const result = await store.restoreRig(
          rigFromPreset({
            version: RIG_PRESET_VERSION,
            name: preset.title,
            rig: preset.currentRevision.rig,
          }),
        );
        if (result.ok) restorePoint = previousRig;
        return result;
      } catch {
        return { ok: false, message: '应用过程异常；请检查当前 Rig 后重试。' };
      }
    },

    async undo() {
      if (!restorePoint) return { ok: false, message: '当前会话没有可撤销的广场音色。' };
      try {
        const result = await store.restoreRig(restorePoint);
        if (result.ok) restorePoint = null;
        return result;
      } catch {
        return { ok: false, message: '暂时无法恢复；撤销点仍保留在当前会话。' };
      }
    },

    canUndo() {
      return restorePoint !== null;
    },
  };
}
