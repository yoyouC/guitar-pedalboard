import { createWorkletLoader } from './workletLoader';

const processorSource = `(() => {
  class LoopbackProbeProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.running = false;
      this.sequence = null;
      this.captured = null;
      this.position = 0;
      this.leadFrames = 0;
      this.level = 0;
      this.port.onmessage = (event) => {
        const message = event.data;
        if (!message || message.type !== 'start' || this.running) return;
        this.sequence = new Float32Array(message.sequence);
        this.captured = new Float32Array(message.captureFrames);
        this.position = 0;
        this.leadFrames = message.leadFrames;
        this.level = message.level;
        this.running = true;
      };
    }

    process(inputs, outputs) {
      const input = inputs[0];
      const output = outputs[0];
      const out = output && output[0];
      if (out) out.fill(0);
      if (!this.running || !this.captured || !this.sequence) return true;
      const inp = input && input[0];
      const frames = out ? out.length : (inp ? inp.length : 128);
      for (let i = 0; i < frames; i++) {
        const absolute = this.position + i;
        if (absolute < this.captured.length) this.captured[absolute] = inp ? (inp[i] || 0) : 0;
        const seqIndex = absolute - this.leadFrames;
        if (out && seqIndex >= 0 && seqIndex < this.sequence.length) {
          out[i] = this.sequence[seqIndex] * this.level;
        }
      }
      this.position += frames;
      if (this.position >= this.captured.length) {
        const captured = this.captured;
        this.running = false;
        this.captured = null;
        this.sequence = null;
        this.port.postMessage({ type: 'complete', captured: captured.buffer }, [captured.buffer]);
      }
      return true;
    }
  }
  registerProcessor('loopback-probe', LoopbackProbeProcessor);
})();`;

export const loadLoopbackProbe = createWorkletLoader(processorSource);
