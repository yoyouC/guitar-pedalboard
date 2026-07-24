/**
 * NAM WASM 的 AudioWorklet 处理器(纯 JS,经 Blob 内联加载,免构建配置)。
 *
 * 多槽位协议(prepare → stage-load × N → stage-active):
 *   1. {type:'prepare', wasmBytes}:暂存 wasm 字节(各槽位实例化共用)。
 *   2. {type:'stage-load', idx, json, activate}:为槽位 idx 实例化专属 wasm
 *      模块并加载模型(耗时 ~0.2-0.5s,preload 期一次性支付),完成后回
 *      {type:'stage-ready', idx};activate=true 时立即切到该槽。
 *   3. {type:'stage-active', idx}:瞬时切换活动槽(样本级,无加载,无爆音)。
 *   4. {type:'conditioning', values}:作用于当前活动槽的条件化模型。
 * 用途:gain 扫档包(同一箱头多个 gain 档位的 capture 预载后,GAIN 旋钮
 * 做无级档位切换);单模型场景等价于只装载槽位 0。
 *
 * 每个槽位的 wasm 模块/模型/I/O 缓冲相互独立(见 docs 的 voice 隔离约束)。
 */
var NAM_BLOCK = 128;

class NamWasmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.wasmBytes = null;
    this.slots = [];
    this.active = -1;
    this.errorReported = false;
    this.suspended = false;
    this.pendingCond = null;
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'prepare') {
        this.wasmBytes = msg.wasmBytes;
      } else if (msg.type === 'stage-load') {
        this.stageLoad(msg);
      } else if (msg.type === 'stage-active') {
        if (this.slots[msg.idx] && this.slots[msg.idx].ready) this.active = msg.idx;
      } else if (msg.type === 'conditioning') {
        this.setConditioning(msg);
      } else if (msg.type === 'suspend') {
        this.suspended = true;
      }
    };
  }

  async stageLoad(msg) {
    if (!this.wasmBytes) {
      this.port.postMessage({ type: 'nam-wasm-error', message: 'stage-load: 未 prepare' });
      return;
    }
    try {
      const bytes = this.wasmBytes;
      const module = await NamWasmModule({
        instantiateWasm: (imports, cb) => {
          WebAssembly.instantiate(bytes, imports).then((result) => {
            cb(result.instance || result);
          });
          return {};
        },
      });
      module._setSampleRate(sampleRate); // worklet 全局采样率,用于 DC blocker
      const json = msg.json;
      const len = module.lengthBytesUTF8(json) + 1;
      const ptr = module._malloc(len);
      module.stringToUTF8(json, ptr, len);
      const rc = module._setDsp(ptr);
      module._free(ptr);
      if (rc !== 1) {
        this.port.postMessage({ type: 'nam-wasm-error', message: `槽位 ${msg.idx}: setDsp 返回 ${rc}` });
        return;
      }
      const slot = {
        module,
        inPtr: module._malloc(NAM_BLOCK * 4),
        outPtr: module._malloc(NAM_BLOCK * 4),
        ready: true,
      };
      this.slots[msg.idx] = slot;
      if (msg.activate || this.active < 0) this.active = msg.idx;
      if (this.pendingCond) {
        this.setConditioning({ values: this.pendingCond });
        this.pendingCond = null;
      }
      this.port.postMessage({ type: 'stage-ready', idx: msg.idx });
    } catch (err) {
      this.port.postMessage({ type: 'nam-wasm-error', message: `槽位 ${msg.idx} 加载失败: ${String(err)}` });
    }
  }

  setConditioning(msg) {
    const slot = this.active >= 0 ? this.slots[this.active] : null;
    if (!slot || !slot.ready) {
      // 无活动槽位:排队,首个槽位就绪后补发
      this.pendingCond = msg.values;
      return;
    }
    const v = msg.values;
    if (!v || !v.length) return;
    const ptr = slot.module._malloc(v.length * 4);
    slot.module.HEAPF32.set(v, ptr >> 2);
    slot.module._setConditioning(v.length, ptr);
    slot.module._free(ptr);
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
    const slot = this.active >= 0 ? this.slots[this.active] : null;
    if (slot && slot.ready && inp.length === NAM_BLOCK) {
      const module = slot.module;
      const heap = module.HEAPF32;
      heap.set(inp, slot.inPtr >> 2);
      module._processAudio(slot.inPtr, slot.outPtr, NAM_BLOCK);
      out.set(heap.subarray(slot.outPtr >> 2, (slot.outPtr >> 2) + NAM_BLOCK));
    } else {
      out.set(inp);
    }
    for (let ch = 1; ch < output.length; ch++) output[ch].set(out);
    return true;
  }
}

registerProcessor('nam-wasm', NamWasmProcessor);
