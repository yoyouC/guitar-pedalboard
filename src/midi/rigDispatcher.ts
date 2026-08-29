/**
 * RigAction dispatch(issue #8,ADR-0004)——无状态纯执行:action 到达即调
 * rigStore verb。MIDI 默认映射、MIDI Learn、键盘三路触发源共享同一分发器,
 * 与 UI 触发走完全相同的 rigStore 代码路径。
 *
 * 链索引/序数 → 具体单块(uid)的解析在本层完成(链状态从 rigStore 读取):
 * - toggle-pedal / set-pedal-enabled / set-pedal-param / set-pedal-treadle:
 *   链上第 index 块(与 UI 平铺顺序一致);
 * - set-expression:序数语义,"第 N 块摇杆踏板"(whammy/wahpedal/crybabywdf)。
 *
 * Looper 动作走注入的 looper 控制(生产端 looperPrimaryCommand 共享守卫,
 * 见 looperState.ts)——"一个命令多个触发源"的范式。测试经 deps 注入 stub
 * (复用 #6 的 createRigStore(stubEngine) 手法,见 tests/rig-action.test.ts)。
 */

import type { RigStore } from '../state/rigStore';
import type { RigAction } from './midiMapping';

/** 表情踏板可驱动的摇杆类踏板(position 语义统一:0=跟位,100=顶位) */
const EXPRESSION_TREADLE_IDS = new Set(['whammy', 'wahpedal', 'crybabywdf']);

export interface RigDispatcherDeps {
  store: Pick<
    RigStore,
    | 'getState'
    | 'togglePedal'
    | 'setPedalEnabled'
    | 'setPedalParam'
    | 'recallSnapshot'
    | 'setGlobalBypass'
    | 'setMasterVolume'
    | 'setAmpParam'
    | 'setPreAmpEqEnabled'
    | 'setPreAmpEqBand'
    | 'setPreAmpEqLevel'
  >;
  looper: {
    /** 主按钮命令(初录→完成→叠录→完成叠录,共享守卫) */
    primary(): void;
    togglePlay(): void;
    clear(): void;
  };
}

export function createRigDispatcher(deps: RigDispatcherDeps): (action: RigAction) => void {
  const { store, looper } = deps;
  return (action) => {
    const { chain } = store.getState();
    switch (action.type) {
      case 'toggle-pedal': {
        const item = chain[action.index];
        if (item) store.togglePedal(item.uid);
        return;
      }
      case 'set-pedal-enabled': {
        const item = chain[action.index];
        if (item) store.setPedalEnabled(item.uid, action.enabled);
        return;
      }
      case 'set-pedal-param': {
        const item = chain[action.index];
        if (item) store.setPedalParam(item.uid, action.key, action.value);
        return;
      }
      case 'set-pedal-treadle': {
        const item = chain[action.index];
        if (item) store.setPedalParam(item.uid, 'position', action.value);
        return;
      }
      case 'set-expression': {
        // 序数 → 第 N 块摇杆类踏板;不做音量/Master 兜底(表情静止=0,
        // 兜底到音量类参数会把输出拉到底)
        const treadles = chain.filter((item) => EXPRESSION_TREADLE_IDS.has(item.effectId));
        const target = treadles[action.index];
        if (target) store.setPedalParam(target.uid, 'position', action.value * 100);
        return;
      }
      case 'recall-snapshot':
        void store.recallSnapshot(action.slot);
        return;
      case 'toggle-bypass':
        store.setGlobalBypass(!store.getState().globalBypass);
        return;
      case 'set-master-volume':
        store.setMasterVolume(action.value);
        return;
      case 'set-amp-param':
        store.setAmpParam(action.key, action.value);
        return;
      case 'toggle-preamp-eq':
        store.setPreAmpEqEnabled(!store.getState().preAmpEq.enabled);
        return;
      case 'set-preamp-eq-band':
        store.setPreAmpEqBand(action.key, action.value);
        return;
      case 'set-preamp-eq-level':
        store.setPreAmpEqLevel(action.value);
        return;
      case 'looper-record':
        looper.primary();
        return;
      case 'looper-toggle-play':
        looper.togglePlay();
        return;
      case 'looper-clear':
        looper.clear();
        return;
    }
  };
}
