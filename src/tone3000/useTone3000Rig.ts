import { useSyncExternalStore } from 'react';
import { loadModelText } from '../audio/namWasm';
import { parseTone3000Key } from '../audio/namWasm';
import { rigStore } from '../state/useRig';
import { rigToShareState } from '../state/rigStore';
import { encodeShareState } from '../state/share';
import {
  browseTone3000,
  loginTone3000,
  logoutTone3000,
  replaceTone3000,
  tone3000,
} from './instance';
import { putCachedToneInfo } from './toneInfoCache';
import {
  createTone3000RigIntegration,
  type Tone3000RigIntegrationState,
} from './rigIntegration';

export const tone3000Rig = createTone3000RigIntegration({
  rig: rigStore,
  port: {
    getTone: async (toneId) => {
      const info = await tone3000.getTone(toneId);
      putCachedToneInfo(info, window.localStorage);
      return info;
    },
    loadModelText,
    selectTone: ({ intent, gear, architecture, loadToneId }) => {
      const encodedRig = () => encodeShareState(rigToShareState(rigStore.getState()));
      const options = { intent, gears: gear, architecture } as const;
      return loadToneId
        ? replaceTone3000(loadToneId, encodedRig, options)
        : browseTone3000(encodedRig, options);
    },
    login: () =>
      loginTone3000(() => encodeShareState(rigToShareState(rigStore.getState()))),
    logout: logoutTone3000,
  },
});

// rigStore 的初始 Share Rig 在模块求值前已应用；由统一编排恢复所有外部目标。
void tone3000Rig.restoreAll();

// Preset/Snapshot/Share 可在任意 UI 路径一次替换整个 Rig。只在外部模型身份变化且
// 编排器尚未持有对应目标时恢复，避免普通旋钮更新触发网络请求。
let reconcileQueued = false;
rigStore.subscribe(() => {
  if (reconcileQueued) return;
  reconcileQueued = true;
  queueMicrotask(() => {
    reconcileQueued = false;
    const rig = rigStore.getState();
    const targets = tone3000Rig.getState().targets;
    const missingPedal = rig.chain.some((item) => {
      const toneId = item.modelRef ? parseTone3000Key(item.modelRef) : null;
      if (toneId === null) return false;
      const target = targets[`pedal:${item.uid}`];
      return !target || target.toneId !== toneId || target.modelId !== item.modelId;
    });
    const ampRef = rig.ampModelKeys[rig.ampCategoryId];
    const ampToneId = ampRef ? parseTone3000Key(ampRef) : null;
    const ampTarget = targets.amp;
    const missingAmp =
      ampToneId !== null &&
      (!ampTarget ||
        ampTarget.toneId !== ampToneId ||
        ampTarget.modelId !== (rig.ampTone3000ModelId ?? undefined));
    if (missingPedal || missingAmp) void tone3000Rig.restoreAll();
  });
});

export function useTone3000Rig<T>(selector: (state: Tone3000RigIntegrationState) => T): T {
  return useSyncExternalStore(tone3000Rig.subscribe, () => selector(tone3000Rig.getState()));
}
