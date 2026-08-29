import type {
  MarketplaceMemberSummary,
  PublishedPresetRevision,
} from '../../shared/marketplace';
import { isPublishedPresetRevisionCompatible } from '../../shared/marketplaceValidation';
import { RIG_PRESET_VERSION } from '../state/presetCodec';
import {
  rigFromPreset,
  rigToApplyState,
  type ApplyRigState,
  type LoadPresetResult,
  type RigStore,
} from '../state/rigStore';
import type { RigProvenance } from '../state/presetCodec';

interface ApplicablePublishedPreset {
  id: string;
  title: string;
  creator: MarketplaceMemberSummary;
  updatedAt: string;
  currentRevision: PublishedPresetRevision;
}

export interface PublishedPresetRigSession {
  apply(preset: ApplicablePublishedPreset): Promise<LoadPresetResult>;
  undo(): Promise<LoadPresetResult>;
  canUndo(): boolean;
}

export function createPublishedPresetRigSession(store: RigStore): PublishedPresetRigSession {
  let restorePoint: { rig: ApplyRigState; provenance: RigProvenance | null } | null = null;

  return {
    async apply(preset) {
      if (!isPublishedPresetRevisionCompatible(preset.currentRevision)) {
        return { ok: false, message: '当前客户端无法忠实应用这个音色，请升级后再试。' };
      }

      const previous = {
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
        if (result.ok) restorePoint = previous;
        return result;
      } catch {
        return { ok: false, message: '应用过程异常；请检查当前 Rig 后重试。' };
      }
    },

    async undo() {
      if (!restorePoint) return { ok: false, message: '当前会话没有可撤销的广场音色。' };
      try {
        const result = await store.restoreRig(restorePoint.rig, restorePoint.provenance);
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
