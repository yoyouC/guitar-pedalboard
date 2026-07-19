/**
 * NAM LSTM 的 AudioWorklet 处理器(纯 JS,经 Blob 内联加载,免构建配置)。
 *
 * 权重布局与 NeuralAmpModelerCore 的 NAM/lstm.cpp 完全一致:
 *   每层: W(4H × (in+H),行主序) + b(4H) + h0(H) + c0(H)
 *   末尾: headW(1×H) + headB(1)
 * 门顺序为 PyTorch 惯例 i/f/g/o;初始状态 h0/c0 来自权重本身。
 *
 * 本文件同时被 scripts/verify-nam-lstm.mjs 在 Node 中 eval 做数值验证,
 * 因此不得包含任何 TypeScript 语法或浏览器专属 API(除 AudioWorklet 接口)。
 */
class NamLstmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.model = null;
    this.cond = new Float32Array(0);
    this.errorReported = false;
    this.suspended = false;
    this.port.onmessage = (e) => {
      const msg = e.data;
      try {
        if (msg.type === 'model') {
          this.setModel(msg);
          this.port.postMessage({ type: 'model-ready', hiddenSize: msg.hiddenSize });
        } else if (msg.type === 'conditioning') this.cond = msg.values;
        else if (msg.type === 'suspend') this.suspended = true;
      } catch (err) {
        this.model = null;
        this.port.postMessage({ type: 'nam-error', message: String(err) });
      }
    };
  }

  setModel(msg) {
    const { inputSize, hiddenSize, numLayers, weights } = msg;
    const H = hiddenSize;
    let off = 0;
    const layers = [];
    for (let l = 0; l < numLayers; l++) {
      const inSize = l === 0 ? inputSize : H;
      const cols = inSize + H;
      const W = weights.slice(off, off + 4 * H * cols);
      off += 4 * H * cols;
      const b = weights.slice(off, off + 4 * H);
      off += 4 * H;
      const h0 = weights.slice(off, off + H);
      off += H;
      const c0 = weights.slice(off, off + H);
      off += H;
      layers.push({
        W,
        b,
        inSize,
        xh: new Float32Array(cols),
        ifgo: new Float32Array(4 * H),
        h: h0.slice(),
        c: c0.slice(),
      });
    }
    const headW = weights.slice(off, off + H);
    off += H;
    const headB = weights[off];
    this.model = { layers, headW, headB };
  }

  process(inputs, outputs) {
    // 已废弃(宿主实例 dispose):返回 false 让节点停止渲染,避免僵尸节点空转音频线程
    if (this.suspended) return false;
    try {
      return this.processImpl(inputs, outputs);
    } catch (err) {
      // 音频线程异常不会进主线程 console,经 port 上报一次,并兜底直通
      if (!this.errorReported) {
        this.errorReported = true;
        this.port.postMessage({ type: 'nam-error', message: `process: ${String(err)}` });
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

    const model = this.model;
    if (!model) {
      // 模型未就绪:直通
      for (let ch = 0; ch < output.length; ch++) {
        output[ch].set(input[ch] && input[ch].length ? input[ch] : input[0]);
      }
      return true;
    }

    const inp = input[0];
    const out = output[0];
    const { layers, headW, headB } = model;
    const cond = this.cond;
    const numLayers = layers.length;

    for (let i = 0; i < inp.length; i++) {
      let hPrev = null;
      for (let l = 0; l < numLayers; l++) {
        const layer = layers[l];
        const { W, b, inSize, xh, ifgo, h, c } = layer;
        const H = h.length;
        const cols = inSize + H;

        if (l === 0) {
          // 微小 DC 偏移防 denormal 性能悬崖
          xh[0] = inp[i] + 1e-18;
          for (let k = 1; k < inSize; k++) xh[k] = cond[k - 1] || 0;
        } else {
          for (let k = 0; k < inSize; k++) xh[k] = hPrev[k];
        }
        // xh 尾部保持本层 h(上一样本的持久状态)
        for (let k = 0; k < H; k++) xh[inSize + k] = h[k];

        for (let r = 0; r < 4 * H; r++) {
          let sum = b[r];
          const row = r * cols;
          for (let j = 0; j < cols; j++) sum += W[row + j] * xh[j];
          ifgo[r] = sum;
        }
        for (let k = 0; k < H; k++) {
          const ig = 1 / (1 + Math.exp(-ifgo[k]));
          const fg = 1 / (1 + Math.exp(-ifgo[H + k]));
          const gg = Math.tanh(ifgo[2 * H + k]);
          const og = 1 / (1 + Math.exp(-ifgo[3 * H + k]));
          let cv = fg * c[k] + ig * gg;
          if (cv < 1e-15 && cv > -1e-15) cv = 0; // flush denormal
          c[k] = cv;
          let hv = og * Math.tanh(cv);
          if (hv < 1e-15 && hv > -1e-15) hv = 0;
          h[k] = hv;
        }
        hPrev = h;
      }
      let y = headB;
      for (let k = 0; k < headW.length; k++) y += headW[k] * hPrev[k];
      out[i] = y;
    }
    for (let ch = 1; ch < output.length; ch++) output[ch].set(out);
    return true;
  }
}

registerProcessor('nam-lstm', NamLstmProcessor);
