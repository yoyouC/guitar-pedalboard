import type { EffectDefinition, EffectInstance } from './effects/types';
import {
  executePlan,
  planGraph,
  type AmpSpec,
  type ChainSpec,
  type PedalEntry,
} from './graphBuilder';
import { loadNoiseGate } from './noiseGateWorklet';
import { loadWahWorklet } from './wahWorklet';
import { loadWhammyWorklet } from './whammyWorklet';
import { loadChampWdf } from './wdf/champWorklet';
import { loadBognerWdf } from './wdf/bognerWorklet';
import { loadTs808Wdf } from './wdf/ts808Worklet';
import { loadRatWdf } from './wdf/ratWorklet';
import { loadTwinWdf } from './wdf/twinWorklet';
import { loadAc30Wdf } from './wdf/ac30Worklet';
import { loadJc120Wdf } from './wdf/jc120Worklet';
import { loadKlonWdf } from './wdf/klonWorklet';
import { loadDs1Wdf } from './wdf/ds1Worklet';
import { loadFuzzFaceWdf } from './wdf/fuzzfaceWorklet';
import { loadCrybabyWdf } from './wdf/crybabyWorklet';
import { loadBigMuffWdf } from './wdf/bigmuffWorklet';
import { loadSpringReverbWdf } from './wdf/springreverbWorklet';
import { loadPlateReverb } from './wdf/plateWorklet';
import { loadShimmerWdf } from './wdf/shimmerWorklet';
import { loadAnalogDelayWdf } from './wdf/analogdelayWorklet';
import { loadTapeDelayWdf } from './wdf/tapedelayWorklet';
import { loadPingPongDelay } from './wdf/pingpongWorklet';
import { loadLa2aOpto } from './wdf/la2aWorklet';
import { loadFet1176 } from './wdf/fet1176Worklet';
import { loadDynaCompWdf } from './wdf/dynacompWorklet';
import { loadNamWasmWorklet } from './namWasmWorklet';
import { loadLooperWorklet } from './looperWorklet';
import {
  INITIAL_LOOPER_STATUS,
  canRunLooperCommand,
  type LooperCommand,
  type LooperStatus,
} from './looperState';

/** 引擎重建链条所需的快照(定义在 graphBuilder,此处 re-export 保持既有 import 路径) */
export type { ChainSpec, AmpSpec } from './graphBuilder';

export type InputSourceType = 'mic' | 'file' | 'test';

/**
 * 音频引擎单例:
 *   输入源 → inputGain → inputAnalyser(仅测量) → [效果链] → looper → outputAnalyser
 *   → limiter(-1dBFS 安全网) → masterGain → destination
 *                          ↘ recorderDest(录音抽头)
 * 限幅器只拦截临近削波的峰值,常态不压缩节目动态;
 * 主音量位于限幅器之后(≤1),监听音量与压缩量解耦,destination 不会过载。
 * 录音抽头与 masterGain 并列(限幅器之后),录音电平不受监听音量影响。
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
  /** 箱头之前的抽头(前置效果链末端,削波检测用) */
  preAmpAnalyser: AnalyserNode | null = null;

  private inputGain: GainNode | null = null;
  private masterGain: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  /** 节拍器总线(挂到限幅前) */
  metronomeBus: GainNode | null = null;
  /** 录音抽头:限幅器之后的 MediaStreamDestination(与监听音量解耦) */
  private recorderDest: MediaStreamAudioDestinationNode | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recordChunks: Blob[] = [];
  /** 完整 Rig 之后、输出表之前的无缝单轨 Looper。 */
  private looperNode: AudioWorkletNode | null = null;
  private looperStatus: LooperStatus = { ...INITIAL_LOOPER_STATUS };
  private looperListeners = new Set<(status: LooperStatus) => void>();

  private sourceNode: AudioNode | null = null;
  private mediaStream: MediaStream | null = null;
  private testTimer: number | null = null;

  // ---- 图谱产物(由 executePlan 返回,整体替换;见 graphBuilder/ADR-0005) ----
  private instances = new Map<string, PedalEntry>();
  private moduleAnalysers = new Map<string, AnalyserNode>();
  private ampInstance: EffectInstance | null = null;
  private ampInstanceDef: EffectDefinition | null = null;
  private ampInstanceKey: string | null = null;
  private cabInstance: EffectInstance | null = null;
  private cabInstanceDef: EffectDefinition | null = null;
  /** 上次实际建图时的 globalBypass;null = 从未建图(首次强制出非空 plan) */
  private graphGlobalBypass: boolean | null = null;

  // ---- Rig 结构 spec(setter 只更新 spec,重建由 planGraph/executePlan 完成) ----
  private chain: ChainSpec[] = [];
  private ampSpec: AmpSpec | null = null;
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
    // 安全网限幅器:仅拦截接近 0dBFS 的峰值;无 lookahead,瞬态仍可能轻微过冲
    this.limiter.threshold.value = -1;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.05;

    this.inputGain.connect(this.inputAnalyser);
    this.outputAnalyser.connect(this.limiter);
    this.limiter.connect(this.masterGain);
    this.masterGain.connect(ctx.destination);
    // 节拍器总线:挂到限幅前,与节目信号同受主音量/限幅控制(也会进录音,符合练琴场景)
    this.metronomeBus = ctx.createGain();
    this.metronomeBus.connect(this.limiter);
    // 录音抽头:与 masterGain 并列,录的是限幅后的节目电平(不受监听音量影响)
    this.recorderDest = ctx.createMediaStreamDestination();
    this.limiter.connect(this.recorderDest);

    try {
      await loadNoiseGate(ctx);
    } catch (e) {
      console.warn('NoiseGate worklet 加载失败,该效果将不可用:', e);
    }
    try {
      await loadWahWorklet(ctx);
    } catch (e) {
      console.warn('Wah worklet 加载失败,该效果将回退为带通:', e);
    }
    try {
      await loadWhammyWorklet(ctx);
    } catch (e) {
      console.warn('Whammy worklet 加载失败,该单块将不可用:', e);
    }
    try {
      await loadCrybabyWdf(ctx);
    } catch (e) {
      console.warn('Crybaby WDF worklet 加载失败,该单块将不可用:', e);
    }
    try {
      await loadChampWdf(ctx);
    } catch (e) {
      console.warn('WDF Champ worklet 加载失败,该箱头将不可用:', e);
    }
    try {
      await loadBognerWdf(ctx);
    } catch (e) {
      console.warn('WDF Bogner worklet 加载失败,该箱头将不可用:', e);
    }
    try {
      await loadTs808Wdf(ctx);
    } catch (e) {
      console.warn('TS808 WDF worklet 加载失败,该单块将不可用:', e);
    }
    try {
      await loadRatWdf(ctx);
    } catch (e) {
      console.warn('RAT WDF worklet 加载失败,该单块将不可用:', e);
    }
    try {
      await loadKlonWdf(ctx);
    } catch (e) {
      console.warn('Klon WDF worklet 加载失败,该单块将不可用:', e);
    }
    try {
      await loadDs1Wdf(ctx);
    } catch (e) {
      console.warn('DS-1 WDF worklet 加载失败,该单块将不可用:', e);
    }
    try {
      await loadFuzzFaceWdf(ctx);
    } catch (e) {
      console.warn('Fuzz Face WDF worklet 加载失败,该单块将不可用:', e);
    }
    try {
      await loadBigMuffWdf(ctx);
    } catch (e) {
      console.warn('Big Muff WDF worklet 加载失败,该单块将不可用:', e);
    }
    try {
      await loadTwinWdf(ctx);
    } catch (e) {
      console.warn('WDF Twin worklet 加载失败,该箱头将不可用:', e);
    }
    try {
      await loadAc30Wdf(ctx);
    } catch (e) {
      console.warn('WDF AC30 worklet 加载失败,该箱头将不可用:', e);
    }
    try {
      await loadJc120Wdf(ctx);
    } catch (e) {
      console.warn('WDF JC-120 worklet 加载失败,该箱头将不可用:', e);
    }
    try {
      await loadSpringReverbWdf(ctx);
    } catch (e) {
      console.warn('弹簧混响 worklet 加载失败:', e);
    }
    try {
      await loadPlateReverb(ctx);
    } catch (e) {
      console.warn('板式混响 worklet 加载失败:', e);
    }
    try {
      await loadShimmerWdf(ctx);
    } catch (e) {
      console.warn('微光混响 worklet 加载失败:', e);
    }
    try {
      await loadAnalogDelayWdf(ctx);
    } catch (e) {
      console.warn('模拟延迟 worklet 加载失败:', e);
    }
    try {
      await loadTapeDelayWdf(ctx);
    } catch (e) {
      console.warn('磁带延迟 worklet 加载失败:', e);
    }
    try {
      await loadPingPongDelay(ctx);
    } catch (e) {
      console.warn('乒乓延迟 worklet 加载失败:', e);
    }
    try {
      await loadLa2aOpto(ctx);
    } catch (e) {
      console.warn('LA-2A worklet 加载失败:', e);
    }
    try {
      await loadFet1176(ctx);
    } catch (e) {
      console.warn('FET1176 worklet 加载失败:', e);
    }
    try {
      await loadDynaCompWdf(ctx);
    } catch (e) {
      console.warn('DynaComp worklet 加载失败:', e);
    }
    try {
      await loadNamWasmWorklet(ctx);
    } catch (e) {
      console.warn('NAM WASM worklet 加载失败,NAM WaveNet 箱头将回退为直通:', e);
    }
    try {
      await loadLooperWorklet(ctx);
      this.looperNode = new AudioWorkletNode(ctx, 'single-track-looper', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
      });
      this.looperNode.connect(this.outputAnalyser);
      this.looperStatus = {
        ...INITIAL_LOOPER_STATUS,
        available: true,
      };
      this.looperNode.port.onmessage = (event: MessageEvent<unknown>) => {
        this.handleLooperMessage(event.data);
      };
      this.emitLooperStatus();
    } catch (e) {
      console.warn('Looper worklet 加载失败,循环功能将不可用:', e);
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

  // ---------- 输出录音 ----------

  /** 是否正在录音 */
  get recording(): boolean {
    return this.mediaRecorder !== null;
  }

  /**
   * 开始录音(webm/opus),返回是否成功启动。
   * 引擎未初始化(尚无用户手势触发的 init)或已在录制时返回 false。
   */
  startRecording(): boolean {
    if (!this.ctx || !this.recorderDest || this.mediaRecorder) return false;
    // 优先 webm/opus;均不支持则用浏览器默认容器
    let mimeType = '';
    for (const t of ['audio/webm;codecs=opus', 'audio/webm']) {
      if (MediaRecorder.isTypeSupported(t)) {
        mimeType = t;
        break;
      }
    }
    const rec = new MediaRecorder(
      this.recorderDest.stream,
      mimeType ? { mimeType } : undefined,
    );
    this.recordChunks = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) this.recordChunks.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(this.recordChunks, { type: rec.mimeType || 'audio/webm' });
      this.recordChunks = [];
      this.mediaRecorder = null;
      this.downloadRecording(blob);
    };
    rec.start(1000); // 每秒一个分片,长录音不必等停止才聚合数据
    this.mediaRecorder = rec;
    return true;
  }

  /** 停止录音;停止后自动触发 .webm 文件下载 */
  stopRecording(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
  }

  /** 生成时间戳文件名并触发浏览器下载 */
  private downloadRecording(blob: Blob): void {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `guitar-pedalboard-${stamp}.webm`;
    a.click();
    // 延迟回收,确保下载已开始
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- Looper ----------

  get currentLooperStatus(): LooperStatus {
    return { ...this.looperStatus };
  }

  subscribeLooper(listener: (status: LooperStatus) => void): () => void {
    this.looperListeners.add(listener);
    listener(this.currentLooperStatus);
    return () => this.looperListeners.delete(listener);
  }

  private emitLooperStatus(): void {
    const snapshot = this.currentLooperStatus;
    for (const listener of this.looperListeners) listener(snapshot);
  }

  private handleLooperMessage(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const message = data as Record<string, unknown>;
    if (message.type !== 'looper-status') return;
    const phase = message.phase;
    if (
      phase !== 'empty' &&
      phase !== 'recording' &&
      phase !== 'playing' &&
      phase !== 'overdubbing' &&
      phase !== 'stopped'
    ) return;
    const sampleRate = this.ctx?.sampleRate ?? 48000;
    const lengthSamples =
      typeof message.lengthSamples === 'number' ? message.lengthSamples : 0;
    const positionSamples =
      typeof message.positionSamples === 'number' ? message.positionSamples : 0;
    this.looperStatus = {
      available: true,
      phase,
      lengthSeconds: Math.max(0, lengthSamples / sampleRate),
      positionSeconds: Math.max(0, positionSamples / sampleRate),
      canUndo: message.canUndo === true,
      message: typeof message.message === 'string' ? message.message : null,
    };
    this.emitLooperStatus();
  }

  private sendLooperCommand(command: LooperCommand): boolean {
    if (!this.looperNode || !canRunLooperCommand(this.looperStatus, command)) {
      return false;
    }
    this.looperNode.port.postMessage({ type: command });
    return true;
  }

  startLoopRecording(): boolean {
    return this.sendLooperCommand('record');
  }

  finishLoopRecording(): boolean {
    return this.sendLooperCommand('finish-record');
  }

  startLoopOverdub(): boolean {
    return this.sendLooperCommand('overdub');
  }

  finishLoopOverdub(): boolean {
    return this.sendLooperCommand('finish-overdub');
  }

  toggleLoopPlayback(): boolean {
    return this.sendLooperCommand('toggle-play');
  }

  undoLoopOverdub(): boolean {
    return this.sendLooperCommand('undo');
  }

  clearLoop(): boolean {
    return this.sendLooperCommand('clear');
  }

  setLoopLevel(value: number): void {
    if (!this.looperNode) return;
    this.looperNode.port.postMessage({
      type: 'set-level',
      value: Math.max(0, Math.min(1.5, value)),
    });
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
    this.instances.get(uid)?.inst.update(key, value);
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

  /**
   * 图谱编译(ADR-0005):决策全部在 planGraph(纯函数,见 graphBuilder.ts),
   * 这里只负责喂 spec/上次产物、调用 executePlan、整体替换 artifacts 字段。
   * 空 plan(spec 无结构变化)直接 no-op,不触碰任何状态。
   */
  private rebuildGraph(): void {
    const ctx = this.ctx;
    if (!ctx || !this.inputGain || !this.inputAnalyser || !this.outputAnalyser) return;

    const plan = planGraph(
      {
        chain: this.chain,
        amp: this.ampSpec,
        cab: this.cabSpec,
        globalBypass: this.globalBypass,
      },
      {
        instances: this.instances,
        ampInstance: this.ampInstance,
        ampInstanceDef: this.ampInstanceDef,
        ampInstanceKey: this.ampInstanceKey,
        cabInstance: this.cabInstance,
        cabInstanceDef: this.cabInstanceDef,
        globalBypass: this.graphGlobalBypass,
      },
    );
    const artifacts = executePlan(
      ctx,
      {
        inputGain: this.inputGain,
        inputAnalyser: this.inputAnalyser,
        outputAnalyser: this.outputAnalyser,
        looperNode: this.looperNode,
      },
      plan,
    );
    if (!artifacts) return;

    this.instances = artifacts.instances;
    this.moduleAnalysers = artifacts.moduleAnalysers;
    this.ampInstance = artifacts.ampInstance;
    this.ampInstanceDef = artifacts.ampInstanceDef;
    this.ampInstanceKey = artifacts.ampInstanceKey;
    this.cabInstance = artifacts.cabInstance;
    this.cabInstanceDef = artifacts.cabInstanceDef;
    this.preAmpAnalyser = artifacts.preAmpAnalyser;
    this.ampAnalyser = artifacts.ampAnalyser;
    this.cabAnalyser = artifacts.cabAnalyser;
    this.graphGlobalBypass = artifacts.globalBypass;
  }
}

export const audioEngine = AudioEngine.instance;

// 开发调试:允许通过 window.__audioEngine 检查引擎状态(CDP 调试用)
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__audioEngine = audioEngine;
}
