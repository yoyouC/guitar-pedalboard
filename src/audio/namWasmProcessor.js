/**
 * NAM WASM 的 AudioWorklet 处理器(纯 JS,经 Blob 内联加载,免构建配置)。
 *
 * 工作流程(init → model → process):
 *   1. 主线程发 {type:'init', wasmBytes}:用传入的 wasm 字节实例化本处理器
 *      专属的 wasm 模块(worklet 作用域不用 fetch,兼容性最好)。
 *   2. 主线程发 {type:'model', json}:.nam 文件原文经 _setDsp 交给 NAM Core 解析。
 *   3. process():每块 128 样本拷入 wasm 内存 → _processAudio → 拷出。
 * 无模型/未初始化时直通。绑定导出见 wasm/nam-dsp-binding.cpp。
 *
 * 注意:wasm 模块、模型、I/O 缓冲全部挂在处理器【实例】上(this.module 等)。
 * 每个 AudioWorkletNode 一条独立 voice——链条里多个 NAM 节点(单块+箱头)
 * 各自加载各自模型互不影响;绝不能用脚本级全局变量共享(否则后加载的
 * 模型覆盖先加载的,所有节点跑同一个模型)。
 */
var NAM_BLOCK = 128;

class NamWasmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.module = null;
    this.inPtr = 0;
    this.outPtr = 0;
    this.errorReported = false;
    this.suspended = false;
    this.pendingCond = null;
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'init') this.init(msg);
      else if (msg.type === 'model') this.setModel(msg);
      else if (msg.type === 'conditioning') this.setConditioning(msg);
      else if (msg.type === 'suspend') this.suspended = true;
    };
  }

  async init(msg) {
    try {
      // NamWasmModule 工厂由拼接加载的 emscripten glue 提供(见 namWasmWorklet.ts);
      // 每个处理器实例各持一个独立模块(独立堆内存/模型/条件状态)
      const bytes = msg.wasmBytes;
      this.module = await NamWasmModule({
        instantiateWasm: (imports, cb) => {
          WebAssembly.instantiate(bytes, imports).then((result) => {
            cb(result.instance || result);
          });
          return {};
        },
      });
      this.inPtr = this.module._malloc(NAM_BLOCK * 4);
      this.outPtr = this.module._malloc(NAM_BLOCK * 4);
      this.module._setSampleRate(sampleRate); // worklet 全局采样率,用于 DC blocker
      if (this.pendingCond) {
        // 补发就绪前被排队的条件值
        this.setConditioning({ values: this.pendingCond });
        this.pendingCond = null;
      }
      this.port.postMessage({ type: 'ready' });
    } catch (err) {
      this.module = null;
      this.port.postMessage({ type: 'nam-wasm-error', message: `init: ${String(err)}` });
    }
  }

  setModel(msg) {
    if (!this.module) {
      this.port.postMessage({ type: 'nam-wasm-error', message: 'model: 模块未初始化' });
      return;
    }
    try {
      const json = msg.json;
      const len = this.module.lengthBytesUTF8(json) + 1;
      const ptr = this.module._malloc(len);
      this.module.stringToUTF8(json, ptr, len);
      const rc = this.module._setDsp(ptr);
      this.module._free(ptr);
      if (rc === 1) this.port.postMessage({ type: 'model-ready' });
      else this.port.postMessage({ type: 'nam-wasm-error', message: `setDsp 返回 ${rc}(不支持的模型?)` });
    } catch (err) {
      this.port.postMessage({ type: 'nam-wasm-error', message: `model: ${String(err)}` });
    }
  }

  setConditioning(msg) {
    if (!this.module) {
      // 模块未初始化:排队,init 完成后补发(否则初始条件被静默丢弃)
      this.pendingCond = msg.values;
      return;
    }
    const v = msg.values;
    if (!v || !v.length) return;
    const ptr = this.module._malloc(v.length * 4);
    this.module.HEAPF32.set(v, ptr >> 2);
    this.module._setConditioning(v.length, ptr);
    this.module._free(ptr);
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
    if (this.module && inp.length === NAM_BLOCK) {
      const heap = this.module.HEAPF32;
      heap.set(inp, this.inPtr >> 2);
      this.module._processAudio(this.inPtr, this.outPtr, NAM_BLOCK);
      out.set(heap.subarray(this.outPtr >> 2, (this.outPtr >> 2) + NAM_BLOCK));
    } else {
      out.set(inp);
    }
    for (let ch = 1; ch < output.length; ch++) output[ch].set(out);
    return true;
  }
}

registerProcessor('nam-wasm', NamWasmProcessor);
