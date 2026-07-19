/**
 * NAM WASM 的 AudioWorklet 处理器(纯 JS,经 Blob 内联加载,免构建配置)。
 *
 * 工作流程(init → model → process):
 *   1. 主线程发 {type:'init', glueUrl, wasmBytes}:importScripts 加载 emscripten
 *      glue,并用传入的 wasm 字节实例化(worklet 作用域不用 fetch,兼容性最好)。
 *   2. 主线程发 {type:'model', json}:.nam 文件原文经 _setDsp 交给 NAM Core 解析。
 *   3. process():每块 128 样本拷入 wasm 内存 → _processAudio → 拷出。
 * 无模型/未初始化时直通。绑定导出见 wasm/nam-dsp-binding.cpp。
 */
var namModule = null;
var namInPtr = 0;
var namOutPtr = 0;
var NAM_BLOCK = 128;

class NamWasmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.errorReported = false;
    this.suspended = false;
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'init') this.init(msg);
      else if (msg.type === 'model') this.setModel(msg);
      else if (msg.type === 'suspend') this.suspended = true;
    };
  }

  async init(msg) {
    try {
      // NamWasmModule 工厂由拼接加载的 emscripten glue 提供(见 namWasmWorklet.ts)
      const bytes = msg.wasmBytes;
      namModule = await NamWasmModule({
        // 不依赖 worklet 内的 fetch/XHR:直接用主线程传来的字节实例化
        instantiateWasm: (imports, cb) => {
          WebAssembly.instantiate(bytes, imports).then((result) => {
            cb(result.instance || result);
          });
          return {};
        },
      });
      namInPtr = namModule._malloc(NAM_BLOCK * 4);
      namOutPtr = namModule._malloc(NAM_BLOCK * 4);
      namModule._setSampleRate(sampleRate); // worklet 全局采样率,用于 DC blocker
      this.port.postMessage({ type: 'ready' });
    } catch (err) {
      namModule = null;
      this.port.postMessage({ type: 'nam-wasm-error', message: `init: ${String(err)}` });
    }
  }

  setModel(msg) {
    if (!namModule) {
      this.port.postMessage({ type: 'nam-wasm-error', message: 'model: 模块未初始化' });
      return;
    }
    try {
      const json = msg.json;
      const len = namModule.lengthBytesUTF8(json) + 1;
      const ptr = namModule._malloc(len);
      namModule.stringToUTF8(json, ptr, len);
      const rc = namModule._setDsp(ptr);
      namModule._free(ptr);
      if (rc === 1) this.port.postMessage({ type: 'model-ready' });
      else this.port.postMessage({ type: 'nam-wasm-error', message: `setDsp 返回 ${rc}(不支持的模型?)` });
    } catch (err) {
      this.port.postMessage({ type: 'nam-wasm-error', message: `model: ${String(err)}` });
    }
  }

  process(inputs, outputs) {
    // 已废弃(宿主实例 dispose):返回 false 让节点停止渲染,避免僵尸节点空转音频线程
    if (this.suspended) return false;
    try {
      return this.processImpl(inputs, outputs);
    } catch (err) {
      if (!this.errorReported) {
        this.errorReported = true;
        this.port.postMessage({ type: 'nam-wasm-error', message: `process: ${String(err)}` });
      }
      const input = inputs[0];
      const output = outputs[0];
      if (input && input.length && output && output.length) {
        for (let ch = 0; ch < output.length; ch++) output[ch].set(input[ch] || input[0]);
      }
      return true;
    }
  }

  processImpl(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !output || !output.length) return true;

    const inp = input[0];
    const out = output[0];
    if (namModule && inp.length === NAM_BLOCK) {
      const heap = namModule.HEAPF32;
      heap.set(inp, namInPtr >> 2);
      namModule._processAudio(namInPtr, namOutPtr, NAM_BLOCK);
      out.set(heap.subarray(namOutPtr >> 2, (namOutPtr >> 2) + NAM_BLOCK));
    } else {
      out.set(inp);
    }
    for (let ch = 1; ch < output.length; ch++) output[ch].set(out);
    return true;
  }
}

registerProcessor('nam-wasm', NamWasmProcessor);
