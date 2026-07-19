/**
 * NAM WASM "voice":一个 AudioWorkletNode + wasm 实例的生命周期封装,
 * 供 NAM 箱头(namWasm.ts)与 NAM 单块(namPedal.ts)共用。
 *
 * 生命周期:create 同步建节点 → 异步初始化 wasm(init: wasm 字节)→ ready
 * → sendModel 送入 .nam JSON。dispose 时通知处理器停止渲染(suspend)。
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
  /** wasm 模块就绪后 resolve */
  ready: Promise<void>;
  /** 送入 .nam 模型 JSON 全文(ready 后调用) */
  sendModel(json: string): void;
  /** 条件化模型:设置 ch1..N 的旋钮值(0..1,顺序与 metadata.controls 一致) */
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

  node.port.onmessage = (e) => {
    const msg = e.data;
    if (msg?.type === 'ready') {
      console.info('[nam-wasm] wasm 模块就绪');
      readyResolve();
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
      node.port.postMessage({ type: 'init', wasmBytes: copy }, [copy]);
    })
    .catch((e) => console.warn('[nam-wasm] wasm 加载失败:', e));

  return {
    node,
    ready,
    sendModel(json) {
      node.port.postMessage({ type: 'model', json });
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
