/**
 * 箱头模型加载进度通道(音频层 → UI 的单向发布/订阅)。
 * 扫档包:逐档推进(done/total);单模型:wasm 初始化/模型下载/装载三步。
 * UI 经 useSyncExternalStore 订阅。
 */
export interface AmpLoadState {
  phase: 'idle' | 'loading' | 'ready';
  done: number;
  total: number;
  /** 当前步骤说明(如 "预载 g5.5") */
  label: string;
}

const IDLE: AmpLoadState = { phase: 'idle', done: 0, total: 0, label: '' };

let state: AmpLoadState = IDLE;
const listeners = new Set<() => void>();

export function getAmpLoadState(): AmpLoadState {
  return state;
}

export function reportAmpLoad(partial: Partial<AmpLoadState>): void {
  state = { ...state, ...partial };
  for (const cb of listeners) cb();
}

export function resetAmpLoad(): void {
  if (state.phase !== 'idle') {
    state = IDLE;
    for (const cb of listeners) cb();
  }
}

export function subscribeAmpLoad(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
