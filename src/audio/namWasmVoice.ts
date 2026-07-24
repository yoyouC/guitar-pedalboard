/**
 * NAM WASM "voice":一个 AudioWorkletNode 的生命周期与多槽位装载封装,
 * 供 NAM 箱头(namWasm.ts)与 NAM 单块(namPedal.ts)共用。
 *
 * 协议(见 namWasmProcessor.js):prepare(wasm 字节)→ stageLoad(每槽一个
 * 模型,加载耗时集中在此)→ stageActive(瞬时切换)。单模型 = 仅槽位 0。
 * dispose 时通知处理器停止渲染(suspend)。
 */

const WASM_URL = `${import.meta.env.BASE_URL}nam-wasm/nam-wasm-glue.wasm`;

let wasmBytesPromise: Promise<ArrayBuffer> | null = null;

function loadWasmBytes(): Promise<ArrayBuffer> {
  if (!wasmBytesPromise) {
    wasmBytesPromise = fetch(WASM_URL).then((r) => {
      if (!r.ok) throw new Error(`wasm 下载失败 HTTP ${r.status}`);
      return r.arrayBuffer();
    });
  }
  return wasmBytesPromise;
}

export interface NamWasmVoice {
  node: AudioWorkletNode;
  /** 首个槽位就绪后 resolve */
  ready: Promise<void>;
  /** 指定槽位就绪后 resolve(串行 preload 用) */
  stageReady(idx: number): Promise<void>;
  /** 装载槽位并加载模型(activate=true 时装完立即切换;单模型用法 = sendModel) */
  stageLoad(idx: number, json: string, activate: boolean): void;
  /** 单模型便捷封装:装载槽位 0 并激活 */
  sendModel(json: string): void;
  /** 瞬时切换活动槽(槽位须已 stage-ready) */
  stageActive(idx: number): void;
  /** 条件化模型:设置活动槽 ch1..N 的旋钮值(0..1,顺序与 metadata.controls 一致) */
  setConditioning(values: number[]): void;
  dispose(): void;
}

/** 创建 NAM WASM voice;worklet 未注册等失败时返回 null(调用方兜底直通) */
export function createNamWasmVoice(ctx: AudioContext): NamWasmVoice | null {
  let node: AudioWorkletNode;
  try {
    node = new AudioWorkletNode(ctx, 'nam-wasm');
  } catch {
    return null;
  }
  let disposed = false;
  let readyResolve: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  const stageWaiters = new Map<number, () => void>();
  let preparePostedResolve: () => void = () => {};
  const preparePosted = new Promise<void>((resolve) => {
    preparePostedResolve = resolve;
  });

  node.port.onmessage = (e) => {
    const msg = e.data;
    if (msg?.type === 'stage-ready') {
      readyResolve();
      const w = stageWaiters.get(msg.idx);
      if (w) {
        stageWaiters.delete(msg.idx);
        w();
      }
    } else if (msg?.type === 'model-ready') {
      console.info('[nam-wasm] 模型已加载');
    } else if (msg?.type === 'nam-wasm-error') {
      console.error(`[nam-wasm] ${msg.message}`);
    }
  };

  loadWasmBytes()
    .then((bytes) => {
      if (disposed) return;
      // transfer 会 detach,拷贝一份再传(缓存保留原字节供后续实例复用)
      const copy = bytes.slice(0);
      node.port.postMessage({ type: 'prepare', wasmBytes: copy }, [copy]);
      preparePostedResolve();
    })
    .catch((e) => console.warn('[nam-wasm] wasm 加载失败:', e));

  return {
    node,
    ready,
    stageReady(idx) {
      return new Promise<void>((resolve) => {
        stageWaiters.set(idx, resolve);
      });
    },
    stageLoad(idx, json, activate) {
      // 必须先等 prepare 发出(port 消息有序,保证处理器先收到 wasm 字节)
      preparePosted.then(() => {
        if (!disposed) node.port.postMessage({ type: 'stage-load', idx, json, activate });
      });
    },
    sendModel(json) {
      node.port.postMessage({ type: 'stage-load', idx: 0, json, activate: true });
    },
    stageActive(idx) {
      node.port.postMessage({ type: 'stage-active', idx });
    },
    setConditioning(values) {
      node.port.postMessage({ type: 'conditioning', values });
    },
    dispose() {
      disposed = true;
      // 通知处理器停止渲染(返回 false),防止僵尸 worklet 空转音频线程
      try {
        node.port.postMessage({ type: 'suspend' });
        node.port.onmessage = null;
      } catch {
        /* 端口已关闭 */
      }
      node.disconnect();
    },
  };
}
