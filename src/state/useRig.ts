/**
 * rigStore 的生产单例与 React 绑定(核心逻辑在 ./rigStore.ts,可在 node 下测试)。
 *
 * - 单例 `rigStore` 注入 audioEngine;启动时经 URL hash 分享参数还原,
 *   无分享参数则用出厂初始预设(DEFAULT_RIG_ENCODED)——语义同旧 App 的挂载 effect。
 * - `useRig(selector)` 是 useSyncExternalStore 绑定;selector 必须返回
 *   原始值或状态内的稳定引用(状态不可变更新),按区块粗粒度订阅,
 *   避免旋钮高频拖动引起无关组件重渲染。
 */

import { useSyncExternalStore } from 'react';
import { audioEngine } from '../audio/AudioEngine';
import { createRigStore, rigFromShare, type ApplyRigState, type RigStoreState } from './rigStore';
import { DEFAULT_RIG_ENCODED, decodeShareState, readShareFromLocation } from './share';

function initialShareRig(): ApplyRigState | null {
  const share = readShareFromLocation() ?? decodeShareState(DEFAULT_RIG_ENCODED);
  return share ? rigFromShare(share) : null;
}

export const rigStore = createRigStore(audioEngine, { initialRig: initialShareRig() });

export function useRig<T>(selector: (state: RigStoreState) => T): T {
  return useSyncExternalStore(rigStore.subscribe, () => selector(rigStore.getState()));
}
