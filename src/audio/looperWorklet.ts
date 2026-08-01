/**
 * 单轨 Looper AudioWorklet。
 *
 * 它位于完整 Rig 之后，以 PCM 直接录制/回放，避免 MediaRecorder 编码延迟造成
 * 循环接缝。初录、回放与叠录始终保留 live through；循环最长两分钟。
 */
import { MAX_LOOP_SECONDS } from './looperState';

const processorSource = `
(() => {
const CHUNK_SIZE = 16384;
const MAX_LOOP_SECONDS = ${MAX_LOOP_SECONDS};

class SingleTrackLooperProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.state = 'empty';
    this.loop = null;
    this.undoLoop = null;
    this.recordChunks = null;
    this.recordLength = 0;
    this.position = 0;
    this.level = 1;
    this.statusTick = 0;
    this.maxSamples = Math.floor(sampleRate * MAX_LOOP_SECONDS);

    this.port.onmessage = (event) => {
      const message = event.data || {};
      switch (message.type) {
        case 'record':
          if (this.state === 'empty') this.beginRecord();
          break;
        case 'finish-record':
          if (this.state === 'recording') this.finishRecord();
          break;
        case 'overdub':
          if ((this.state === 'playing' || this.state === 'stopped') && this.loop) {
            this.undoLoop = this.loop.map((channel) => channel.slice());
            this.state = 'overdubbing';
            this.postStatus();
          }
          break;
        case 'finish-overdub':
          if (this.state === 'overdubbing') {
            this.state = 'playing';
            this.postStatus();
          }
          break;
        case 'toggle-play':
          if (this.state === 'playing') this.state = 'stopped';
          else if (this.state === 'stopped' && this.loop) this.state = 'playing';
          this.postStatus();
          break;
        case 'undo':
          if (this.undoLoop && (this.state === 'playing' || this.state === 'stopped')) {
            this.loop = this.undoLoop;
            this.undoLoop = null;
            if (this.loop[0].length) this.position %= this.loop[0].length;
            this.postStatus();
          }
          break;
        case 'clear':
          this.clear();
          break;
        case 'set-level':
          if (Number.isFinite(message.value)) {
            this.level = Math.max(0, Math.min(1.5, message.value));
          }
          break;
      }
    };
    this.postStatus();
  }

  beginRecord() {
    this.recordChunks = [[], []];
    this.recordLength = 0;
    this.position = 0;
    this.undoLoop = null;
    this.state = 'recording';
    this.postStatus();
  }

  writeRecordSample(channel, index, value) {
    const chunkIndex = Math.floor(index / CHUNK_SIZE);
    const chunkOffset = index % CHUNK_SIZE;
    let chunk = this.recordChunks[channel][chunkIndex];
    if (!chunk) {
      chunk = new Float32Array(CHUNK_SIZE);
      this.recordChunks[channel][chunkIndex] = chunk;
    }
    chunk[chunkOffset] = value;
  }

  capture(input, frameCount) {
    const start = this.recordLength;
    const remaining = Math.max(0, this.maxSamples - start);
    const count = Math.min(frameCount, remaining);
    for (let i = 0; i < count; i++) {
      for (let channel = 0; channel < 2; channel++) {
        const source = input[channel] || input[0];
        this.writeRecordSample(channel, start + i, source ? source[i] : 0);
      }
    }
    this.recordLength += count;
    this.position = this.recordLength;
    if (this.recordLength >= this.maxSamples) {
      this.finishRecord('已达到 02:00 最长循环');
    }
  }

  finishRecord(message) {
    if (!this.recordChunks || this.recordLength === 0) {
      this.clear();
      return;
    }
    this.loop = [new Float32Array(this.recordLength), new Float32Array(this.recordLength)];
    for (let channel = 0; channel < 2; channel++) {
      let offset = 0;
      for (const chunk of this.recordChunks[channel]) {
        const count = Math.min(chunk.length, this.recordLength - offset);
        if (count <= 0) break;
        this.loop[channel].set(chunk.subarray(0, count), offset);
        offset += count;
      }
    }
    this.recordChunks = null;
    this.position = 0;
    this.state = 'playing';
    this.postStatus(message);
  }

  clear() {
    this.state = 'empty';
    this.loop = null;
    this.undoLoop = null;
    this.recordChunks = null;
    this.recordLength = 0;
    this.position = 0;
    this.postStatus();
  }

  postStatus(message) {
    const length = this.loop ? this.loop[0].length : this.recordLength;
    this.port.postMessage({
      type: 'looper-status',
      phase: this.state,
      lengthSamples: length,
      positionSamples: this.position,
      canUndo: Boolean(this.undoLoop),
      message: message || null,
    });
  }

  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    const frameCount = output[0] ? output[0].length : 128;

    if (this.state === 'recording') this.capture(input, frameCount);

    const shouldPlay = Boolean(this.loop) &&
      (this.state === 'playing' || this.state === 'overdubbing');
    const loopLength = this.loop ? this.loop[0].length : 0;

    for (let i = 0; i < frameCount; i++) {
      const loopPosition = this.position;
      for (let channel = 0; channel < output.length; channel++) {
        const source = input[channel] || input[0];
        const live = source ? source[i] : 0;
        let loopSample = 0;
        if (shouldPlay && loopLength) {
          const loopChannel = this.loop[channel] || this.loop[0];
          loopSample = loopChannel[loopPosition];
          if (this.state === 'overdubbing') loopChannel[loopPosition] += live;
        }
        output[channel][i] = live + loopSample * this.level;
      }
      if (shouldPlay && loopLength) this.position = (loopPosition + 1) % loopLength;
    }

    this.statusTick++;
    if (this.statusTick >= 16) {
      this.statusTick = 0;
      this.postStatus();
    }
    return true;
  }
}

registerProcessor('single-track-looper', SingleTrackLooperProcessor);
})();
`;

const loadedContexts = new WeakSet<AudioContext>();

export async function loadLooperWorklet(ctx: AudioContext): Promise<void> {
  if (loadedContexts.has(ctx)) return;
  const url = URL.createObjectURL(
    new Blob([processorSource], { type: 'application/javascript' }),
  );
  try {
    await ctx.audioWorklet.addModule(url);
    loadedContexts.add(ctx);
  } finally {
    URL.revokeObjectURL(url);
  }
}
