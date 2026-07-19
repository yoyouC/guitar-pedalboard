import type { EffectDefinition, EffectInstance } from './effects/types';
import { loadNoiseGate } from './noiseGateWorklet';
import { loadNamWorklet } from './namWorklet';
import { loadNamWasmWorklet } from './namWasmWorklet';

/** 引擎重建链条所需的快照 */
export interface ChainSpec {
  uid: string;
  def: EffectDefinition;
  enabled: boolean;
  values: Record<string, number>;
}

/** 箱头快照(null 表示不启用箱头) */
export interface AmpSpec {
  def: EffectDefinition;
  enabled: boolean;
  values: Record<string, number>;
}

export type InputSourceType = 'mic' | 'file' | 'test';

/**
 * 音频引擎单例:
 *   输入源 → inputGain → inputAnalyser(仅测量) → [效果链] → outputAnalyser
 *   → masterGain → limiter → destination
 */
class AudioEngine {
  private static _instance = new AudioEngine();
  static get instance(): AudioEngine {
    return this._instance;
  }
  private constructor() {}

  ctx: AudioContext | null = null;
  inputAnalyser: AnalyserNode | null = null;
  outputAnalyser: AnalyserNode | null = null;
  /** 箱头/箱体输出侧的电平表抽头(随图谱重建更新) */
  ampAnalyser: AnalyserNode | null = null;
  cabAnalyser: AnalyserNode | null = null;

  private inputGain: GainNode | null = null;
  private masterGain: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;

  private sourceNode: AudioNode | null = null;
  private mediaStream: MediaStream | null = null;
  private testTimer: number | null = null;

  private instances: { uid: string; inst: EffectInstance }[] = [];
  private moduleAnalysers = new Map<string, AnalyserNode>();
  private chain: ChainSpec[] = [];
  private ampInstance: EffectInstance | null = null;
  private ampSpec: AmpSpec | null = null;
  private cabInstance: EffectInstance | null = null;
  private cabSpec: AmpSpec | null = null;
  private globalBypass = false;

  /** 创建/恢复 AudioContext,搭建固定主链路。幂等。 */
  async init(): Promise<void> {
    if (this.ctx) {
      await this.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;

    this.inputGain = ctx.createGain();
    this.inputAnalyser = ctx.createAnalyser();
    this.inputAnalyser.fftSize = 2048;
    this.outputAnalyser = ctx.createAnalyser();
    this.outputAnalyser.fftSize = 2048;
    this.masterGain = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -12;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.1;

    this.inputGain.connect(this.inputAnalyser);
    this.outputAnalyser.connect(this.masterGain);
    this.masterGain.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    try {
      await loadNoiseGate(ctx);
    } catch (e) {
      console.warn('NoiseGate worklet 加载失败,该效果将不可用:', e);
    }
    try {
      await loadNamWorklet(ctx);
    } catch (e) {
      console.warn('NAM worklet 加载失败,NAM 箱头将回退为直通:', e);
    }
    try {
      await loadNamWasmWorklet(ctx);
    } catch (e) {
      console.warn('NAM WASM worklet 加载失败,NAM WaveNet 箱头将回退为直通:', e);
    }
    this.rebuildGraph();
  }

  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
  }

  // ---------- 输入 / 输出 ----------

  setInputGain(v: number): void {
    if (this.ctx && this.inputGain) {
      this.inputGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    }
  }

  setMasterVolume(v: number): void {
    if (this.ctx && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    }
  }

  private stopSource(): void {
    if (this.testTimer !== null) {
      clearInterval(this.testTimer);
      this.testTimer = null;
    }
    if (this.sourceNode) {
      try {
        (this.sourceNode as AudioBufferSourceNode).stop?.();
      } catch {
        /* 已停止 */
      }
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
  }

  async useMic(deviceId?: string): Promise<void> {
    await this.init();
    this.stopSource();
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.sourceNode = this.ctx!.createMediaStreamSource(this.mediaStream);
    this.sourceNode.connect(this.inputGain!);
  }

  async useFile(file: File): Promise<void> {
    await this.init();
    this.stopSource();
    const buffer = await this.ctx!.decodeAudioData(await file.arrayBuffer());
    const src = this.ctx!.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(this.inputGain!);
    src.start();
    this.sourceNode = src;
  }

  /** 内置测试音源:Karplus-Strong 渲染的清音电吉他 riff(public/samples),加载失败回退到合成 riff */
  async useTestTone(): Promise<void> {
    await this.init();
    this.stopSource();
    try {
      const url = `${import.meta.env.BASE_URL}samples/guitar-riff.wav`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = await this.ctx!.decodeAudioData(await res.arrayBuffer());
      const src = this.ctx!.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.connect(this.inputGain!);
      src.start();
      this.sourceNode = src;
    } catch (e) {
      console.warn('吉他 riff 采样加载失败,回退到合成 riff:', e);
      this.useSynthRiff();
    }
  }

  /** 备用合成 riff:循环播放的程序合成音符 */
  private useSynthRiff(): void {
    const ctx = this.ctx!;
    const bus = ctx.createGain();
    bus.connect(this.inputGain!);
    this.sourceNode = bus;

    // A 小调五声音阶 riff
    const notes = [110, 130.81, 146.83, 164.81, 196, 220, 196, 164.81];
    let step = 0;
    const playNote = () => {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = notes[step % notes.length];
      step++;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1400;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
      osc.connect(lp);
      lp.connect(g);
      g.connect(bus);
      osc.start(t);
      osc.stop(t + 0.28);
    };
    playNote();
    this.testTimer = window.setInterval(playNote, 300);
  }

  stopInput(): void {
    this.stopSource();
  }

  /** 选择输出设备(浏览器支持 setSinkId 时) */
  async setOutputDevice(deviceId: string): Promise<boolean> {
    if (!this.ctx) return false;
    const ctx = this.ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (typeof ctx.setSinkId !== 'function') return false;
    await ctx.setSinkId(deviceId);
    return true;
  }

  // ---------- 效果链 ----------

  setGlobalBypass(bypass: boolean): void {
    this.globalBypass = bypass;
    this.rebuildGraph();
  }

  /** 整体替换链条并重建音频图(增删/排序/开关时调用) */
  setChain(chain: ChainSpec[]): void {
    this.chain = chain;
    this.rebuildGraph();
  }

  /** 参数连续调整,不重建图 */
  updateParam(uid: string, key: string, value: number): void {
    const found = this.instances.find((i) => i.uid === uid);
    found?.inst.update(key, value);
  }

  /** 某模块输出侧的电平表节点(不存在则 null) */
  getModuleAnalyser(uid: string): AnalyserNode | null {
    return this.moduleAnalysers.get(uid) ?? null;
  }

  /** 设置/替换箱头(结构变化,重建图) */
  setAmp(spec: AmpSpec | null): void {
    this.ampSpec = spec;
    this.rebuildGraph();
  }

  /** 箱头参数连续调整,不重建图 */
  updateAmpParam(key: string, value: number): void {
    this.ampInstance?.update(key, value);
  }

  /** 设置/替换箱体(结构变化,重建图) */
  setCab(spec: AmpSpec | null): void {
    this.cabSpec = spec;
    this.rebuildGraph();
  }

  /** 箱体参数连续调整,不重建图 */
  updateCabParam(key: string, value: number): void {
    this.cabInstance?.update(key, value);
  }

  private rebuildGraph(): void {
    const ctx = this.ctx;
    if (!ctx || !this.inputGain || !this.outputAnalyser) return;

    this.instances.forEach((i) => i.inst.dispose());
    this.instances = [];
    this.moduleAnalysers.clear();
    if (this.ampInstance) {
      this.ampInstance.dispose();
      this.ampInstance = null;
    }
    if (this.cabInstance) {
      this.cabInstance.dispose();
      this.cabInstance = null;
    }
    this.ampAnalyser = null;
    this.cabAnalyser = null;

    // 断开 inputGain 全部下游(含 analyser 与旧链),再按新链重连
    this.inputGain.disconnect();
    this.inputGain.connect(this.inputAnalyser!);

    let prev: AudioNode = this.inputGain;
    if (!this.globalBypass) {
      for (const spec of this.chain) {
        if (!spec.enabled) continue;
        const inst = spec.def.create(ctx);
        for (const [k, v] of Object.entries(spec.values)) inst.update(k, v);
        prev.connect(inst.input);
        prev = inst.output;
        // 模块输出电平表抽头(仅测量,不影响音频路径)
        const tap = ctx.createAnalyser();
        tap.fftSize = 1024;
        inst.output.connect(tap);
        this.moduleAnalysers.set(spec.uid, tap);
        this.instances.push({ uid: spec.uid, inst });
      }
      // 箱头位于效果链之后(踏板 → 箱头的真实路由)
      if (this.ampSpec && this.ampSpec.enabled) {
        const amp = this.ampSpec.def.create(ctx);
        for (const [k, v] of Object.entries(this.ampSpec.values)) amp.update(k, v);
        prev.connect(amp.input);
        prev = amp.output;
        this.ampInstance = amp;
        this.ampAnalyser = ctx.createAnalyser();
        this.ampAnalyser.fftSize = 1024;
        amp.output.connect(this.ampAnalyser);
      }
      // 箱体位于箱头之后、输出之前(关闭即 DI 直通)
      if (this.cabSpec && this.cabSpec.enabled) {
        const cab = this.cabSpec.def.create(ctx);
        for (const [k, v] of Object.entries(this.cabSpec.values)) cab.update(k, v);
        prev.connect(cab.input);
        prev = cab.output;
        this.cabInstance = cab;
        this.cabAnalyser = ctx.createAnalyser();
        this.cabAnalyser.fftSize = 1024;
        cab.output.connect(this.cabAnalyser);
      }
    }
    prev.connect(this.outputAnalyser);
  }
}

export const audioEngine = AudioEngine.instance;

// 开发调试:允许通过 window.__audioEngine 检查引擎状态(CDP 调试用)
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__audioEngine = audioEngine;
}
