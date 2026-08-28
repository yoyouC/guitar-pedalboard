import type { EffectDefinition, EffectInstance } from './effects/types';
import {
  executePlan,
  planGraph,
  type AmpSpec,
  type ChainSpec,
  type GraphArtifacts,
  type GraphPrevState,
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
import { loadLoopbackProbe } from './loopbackWorklet';
import {
  INITIAL_LOOPER_STATUS,
  canRunLooperCommand,
  type LooperCommand,
  type LooperStatus,
} from './looperState';
import {
  audioContextOptions,
  loadAudioProfile,
  openMicWithFallback,
  saveAudioProfile,
  type AudioProfile,
} from './audioProfile';
import {
  LatencyWindow,
  readPlaybackStats,
  type AudioDiagnosticsSnapshot,
} from './audioDiagnostics';
import { calculateRigLatency } from './latency';
import {
  analyzeLoopback,
  calibrationMatches,
  createLoopbackSequence,
  loadLoopbackCalibration,
  saveLoopbackCalibration,
  type LoopbackAnalysis,
  type LoopbackCalibrationKey,
  type StoredLoopbackCalibration,
} from './loopbackCalibration';
import { assertRuntimeRevision, profileSwitchBlock, runRuntimeTransaction } from './runtimeTransaction';
import { LongTaskTracker, type StabilityObservation } from './performanceDiagnostics';
import { cabIrRefKey, type CabIrRef } from './cabIrTypes';
import {
  CAB_IR_RUNTIME_DEF,
  CabIrBufferResolver,
  isCabIrEffectInstance,
  stageInitialCabIrBuffer,
  type PreparedCabIrBuffer,
} from './cabIrRuntime';

/** 引擎重建链条所需的快照(定义在 graphBuilder,此处 re-export 保持既有 import 路径) */
export type { ChainSpec, AmpSpec } from './graphBuilder';

export interface CabSpec extends AmpSpec {
  irRef?: CabIrRef;
}

export type InputSourceType = 'mic' | 'file' | 'test';

interface RuntimeGraphState {
  instances: Map<string, PedalEntry>;
  moduleAnalysers: Map<string, AnalyserNode>;
  ampInstance: EffectInstance | null;
  ampInstanceDef: EffectDefinition | null;
  ampInstanceKey: string | null;
  cabInstance: EffectInstance | null;
  cabInstanceDef: EffectDefinition | null;
  cabInstanceKey: string | null;
  preAmpAnalyser: AnalyserNode | null;
  ampAnalyser: AnalyserNode | null;
  cabAnalyser: AnalyserNode | null;
  globalBypass: boolean | null;
}

interface AudioRuntime {
  ctx: AudioContext;
  inputGain: GainNode;
  inputAnalyser: AnalyserNode;
  outputAnalyser: AnalyserNode;
  masterGain: GainNode;
  limiter: DynamicsCompressorNode;
  metronomeBus: GainNode;
  recorderDest: MediaStreamAudioDestinationNode;
  looperNode: AudioWorkletNode | null;
  loadedWorklets: Set<string>;
  graph: RuntimeGraphState;
  cabIrFallbackActive: boolean;
}

type InputDescriptor =
  | { type: 'mic'; deviceId?: string; stream: MediaStream }
  | { type: 'file'; file: File }
  | { type: 'test' };

interface PreparedSource {
  node: AudioNode;
  startTimer?: () => number;
  descriptor?: InputDescriptor;
  inputDegraded?: boolean;
  cleanup?: () => void;
}

export interface AudioEngineOptions {
  createContext?: (options: AudioContextOptions) => AudioContext;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  cabIrResolver?: CabIrBufferResolver;
}

export type AudioProfileSwitchResult =
  | { ok: true }
  | { ok: false; reason: 'recording' | 'looper-not-empty' | 'failed'; message: string };

interface WorkletRegistration {
  label: string;
  load: (ctx: AudioContext) => Promise<void>;
}

const WORKLETS: readonly WorkletRegistration[] = [
  { label: 'NoiseGate', load: loadNoiseGate },
  { label: 'Wah', load: loadWahWorklet },
  { label: 'Whammy', load: loadWhammyWorklet },
  { label: 'Crybaby WDF', load: loadCrybabyWdf },
  { label: 'WDF Champ', load: loadChampWdf },
  { label: 'WDF Bogner', load: loadBognerWdf },
  { label: 'TS808 WDF', load: loadTs808Wdf },
  { label: 'RAT WDF', load: loadRatWdf },
  { label: 'Klon WDF', load: loadKlonWdf },
  { label: 'DS-1 WDF', load: loadDs1Wdf },
  { label: 'Fuzz Face WDF', load: loadFuzzFaceWdf },
  { label: 'Big Muff WDF', load: loadBigMuffWdf },
  { label: 'WDF Twin', load: loadTwinWdf },
  { label: 'WDF AC30', load: loadAc30Wdf },
  { label: 'WDF JC-120', load: loadJc120Wdf },
  { label: 'Spring Reverb', load: loadSpringReverbWdf },
  { label: 'Plate Reverb', load: loadPlateReverb },
  { label: 'Shimmer', load: loadShimmerWdf },
  { label: 'Analog Delay', load: loadAnalogDelayWdf },
  { label: 'Tape Delay', load: loadTapeDelayWdf },
  { label: 'Ping Pong Delay', load: loadPingPongDelay },
  { label: 'LA-2A', load: loadLa2aOpto },
  { label: 'FET1176', load: loadFet1176 },
  { label: 'DynaComp', load: loadDynaCompWdf },
  { label: 'NAM WASM', load: loadNamWasmWorklet },
  { label: 'Looper', load: loadLooperWorklet },
  { label: 'Loopback Probe', load: loadLoopbackProbe },
];

function emptyGraphState(): RuntimeGraphState {
  return {
    instances: new Map(),
    moduleAnalysers: new Map(),
    ampInstance: null,
    ampInstanceDef: null,
    ampInstanceKey: null,
    cabInstance: null,
    cabInstanceDef: null,
    cabInstanceKey: null,
    preAmpAnalyser: null,
    ampAnalyser: null,
    cabAnalyser: null,
    globalBypass: null,
  };
}

function graphPrevState(graph: RuntimeGraphState): GraphPrevState {
  return {
    instances: graph.instances,
    ampInstance: graph.ampInstance,
    ampInstanceDef: graph.ampInstanceDef,
    ampInstanceKey: graph.ampInstanceKey,
    cabInstance: graph.cabInstance,
    cabInstanceDef: graph.cabInstanceDef,
    cabInstanceKey: graph.cabInstanceKey,
    globalBypass: graph.globalBypass,
  };
}

function applyArtifacts(runtime: AudioRuntime, artifacts: GraphArtifacts): void {
  runtime.graph = {
    instances: artifacts.instances,
    moduleAnalysers: artifacts.moduleAnalysers,
    ampInstance: artifacts.ampInstance,
    ampInstanceDef: artifacts.ampInstanceDef,
    ampInstanceKey: artifacts.ampInstanceKey,
    cabInstance: artifacts.cabInstance,
    cabInstanceDef: artifacts.cabInstanceDef,
    cabInstanceKey: artifacts.cabInstanceKey,
    preAmpAnalyser: artifacts.preAmpAnalyser,
    ampAnalyser: artifacts.ampAnalyser,
    cabAnalyser: artifacts.cabAnalyser,
    globalBypass: artifacts.globalBypass,
  };
}

function finiteMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value * 1000 : null;
}

function browserMajor(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const match = navigator.userAgent.match(/(Chrome|Edg|Firefox|Version)\/(\d+)/);
  return match ? `${match[1]} ${match[2]}` : 'unknown';
}

function osAudioConfig(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return 'Windows-default';
  if (/Mac OS|Macintosh/i.test(ua)) return 'macOS-default';
  if (/Linux/i.test(ua)) return 'Linux-default';
  return 'unknown';
}

function emptyDiagnostics(profile: AudioProfile): AudioDiagnosticsSnapshot {
  return {
    ready: false,
    runtimeVersion: 0,
    profile,
    profileIgnored: false,
    degradedInput: false,
    workletFailures: [],
    warning: null,
    baseLatencyMs: null,
    outputLatencyMs: null,
    outputEstimate: { medianMs: null, minMs: null, maxMs: null, samples: 0 },
    sampleRate: null,
    inputSettings: null,
    playback: {
      supported: false,
      underrunEvents: null,
      underrunDurationMs: null,
      averageLatencyMs: null,
      minimumLatencyMs: null,
      maximumLatencyMs: null,
    },
    mainThread: { supported: false, longTaskCount: 0, longTaskDurationMs: 0 },
    stabilityObservation: null,
    rigLatency: null,
    calibrationMs: null,
  };
}

/**
 * 音频引擎单例：把 Context 生命周期、输入源、固定输出级、Looper 与图谱编译
 * 藏在一个深 module 后。音频档位切换准备完整新 runtime 后才提交；失败保留旧 runtime。
 */
export class AudioEngine {
  private readonly createContext: (options: AudioContextOptions) => AudioContext;
  private readonly getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  private readonly cabIrResolver: CabIrBufferResolver;
  private runtime: AudioRuntime | null = null;
  private profile: AudioProfile = loadAudioProfile();
  private outputDeviceId = 'default';
  private inputGainValue = 1;
  private masterVolumeValue = 0.5;

  private inputDescriptor: InputDescriptor | null = null;
  private sourceNode: AudioNode | null = null;
  private testTimer: number | null = null;
  private inputDegraded = false;

  private mediaRecorder: MediaRecorder | null = null;
  private recordChunks: Blob[] = [];
  private looperStatus: LooperStatus = { ...INITIAL_LOOPER_STATUS };
  private looperListeners = new Set<(status: LooperStatus) => void>();

  private chain: ChainSpec[] = [];
  private ampSpec: AmpSpec | null = null;
  private cabSpec: CabSpec | null = null;
  private cabIrRef: CabIrRef = { kind: 'builtin', id: 'gb4x12' };
  /** 使候选 AudioContext 无法提交在 prepare 期间已经过期的 IR。 */
  private cabIrVersion = 0;
  private globalBypass = false;

  private diagnostics = emptyDiagnostics(this.profile);
  private diagnosticsListeners = new Set<(snapshot: AudioDiagnosticsSnapshot) => void>();
  private diagnosticsTimer: number | null = null;
  private latencyWindow = new LatencyWindow(5);
  private profileLatencies = new Map<AudioProfile, number>();
  private runtimeVersion = 0;
  private calibration: StoredLoopbackCalibration | null = loadLoopbackCalibration();
  private longTasks = new LongTaskTracker();
  private stabilityObservation: StabilityObservation | null = null;

  constructor(options: AudioEngineOptions = {}) {
    this.createContext = options.createContext ?? ((contextOptions) => new AudioContext(contextOptions));
    this.getUserMedia = options.getUserMedia ?? ((constraints) => navigator.mediaDevices.getUserMedia(constraints));
    this.cabIrResolver = options.cabIrResolver ?? new CabIrBufferResolver();
  }

  get ctx(): AudioContext | null {
    return this.runtime?.ctx ?? null;
  }
  get inputAnalyser(): AnalyserNode | null {
    return this.runtime?.inputAnalyser ?? null;
  }
  get outputAnalyser(): AnalyserNode | null {
    return this.runtime?.outputAnalyser ?? null;
  }
  get preAmpAnalyser(): AnalyserNode | null {
    return this.runtime?.graph.preAmpAnalyser ?? null;
  }
  get ampAnalyser(): AnalyserNode | null {
    return this.runtime?.graph.ampAnalyser ?? null;
  }
  get cabAnalyser(): AnalyserNode | null {
    return this.runtime?.graph.cabAnalyser ?? null;
  }
  get metronomeBus(): GainNode | null {
    return this.runtime?.metronomeBus ?? null;
  }
  get audioProfile(): AudioProfile {
    return this.profile;
  }
  get activeInputType(): InputSourceType | null {
    return this.inputDescriptor?.type ?? null;
  }

  /** 创建/恢复当前 AudioContext。幂等。 */
  async init(): Promise<void> {
    this.longTasks.start();
    if (this.runtime) {
      await this.resume();
      return;
    }
    const runtime = await this.prepareRuntime(this.profile, false, false);
    this.runtime = runtime;
    this.runtimeVersion++;
    this.resetLooperForRuntime(runtime);
    await this.resume();
    this.startDiagnostics();
  }

  async resume(): Promise<void> {
    if (this.runtime?.ctx.state === 'suspended') await this.runtime.ctx.resume();
  }

  /** 页面卸载/测试清理；生产中通常由单例随页面存活。 */
  async dispose(): Promise<void> {
    if (this.diagnosticsTimer !== null) {
      window.clearInterval(this.diagnosticsTimer);
      this.diagnosticsTimer = null;
    }
    this.stopSource();
    const runtime = this.runtime;
    this.runtime = null;
    if (runtime) await this.disposeRuntime(runtime);
    this.longTasks.disconnect();
    this.runtimeVersion++;
    this.diagnostics = { ...emptyDiagnostics(this.profile), runtimeVersion: this.runtimeVersion };
    this.emitDiagnostics();
  }

  private async registerWorklets(ctx: AudioContext, strict: boolean): Promise<Set<string>> {
    const loaded = new Set<string>();
    const failures: Error[] = [];
    for (const entry of WORKLETS) {
      try {
        await entry.load(ctx);
        loaded.add(entry.label);
      } catch (cause) {
        const error = new Error(`${entry.label} Worklet 加载失败`, { cause });
        failures.push(error);
        console.warn(`${entry.label} Worklet 加载失败，将使用模块兜底:`, cause);
      }
    }
    if (strict && failures.length > 0) throw new AggregateError(failures, '新 AudioContext 未能完整加载 Worklet');
    return loaded;
  }

  private async prepareRuntime(
    profile: AudioProfile,
    suspend: boolean,
    strictWorklets: boolean,
  ): Promise<AudioRuntime> {
    const ctx = this.createContext(audioContextOptions(profile));
    try {
      if (suspend && ctx.state === 'running') await ctx.suspend();

      const inputGain = ctx.createGain();
      inputGain.gain.value = this.inputGainValue;
      const inputAnalyser = ctx.createAnalyser();
      inputAnalyser.fftSize = 2048;
      const outputAnalyser = ctx.createAnalyser();
      outputAnalyser.fftSize = 2048;
      const masterGain = ctx.createGain();
      masterGain.gain.value = this.masterVolumeValue;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -1;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.05;

      inputGain.connect(inputAnalyser);
      outputAnalyser.connect(limiter);
      limiter.connect(masterGain);
      masterGain.connect(ctx.destination);
      const metronomeBus = ctx.createGain();
      metronomeBus.connect(limiter);
      const recorderDest = ctx.createMediaStreamDestination();
      limiter.connect(recorderDest);

      const loaded = await this.registerWorklets(ctx, strictWorklets);
      let looperNode: AudioWorkletNode | null = null;
      if (loaded.has('Looper')) {
        try {
          looperNode = new AudioWorkletNode(ctx, 'single-track-looper', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            channelCount: 2,
            channelCountMode: 'explicit',
          });
          looperNode.connect(outputAnalyser);
          looperNode.port.onmessage = (event: MessageEvent<unknown>) => this.handleLooperMessage(event.data);
        } catch (cause) {
          if (strictWorklets) throw cause;
          console.warn('Looper 节点创建失败，完整 Rig 将安全直通输出:', cause);
        }
      }

      const runtime: AudioRuntime = {
        ctx,
        inputGain,
        inputAnalyser,
        outputAnalyser,
        masterGain,
        limiter,
        metronomeBus,
        recorderDest,
        looperNode,
        loadedWorklets: loaded,
        graph: emptyGraphState(),
        cabIrFallbackActive: false,
      };
      if (this.cabSpec?.def === CAB_IR_RUNTIME_DEF) {
        let activeIr: Awaited<ReturnType<CabIrBufferResolver['resolve']>>;
        try {
          activeIr = await this.cabIrResolver.resolve(ctx, this.cabIrRef);
          runtime.cabIrFallbackActive = false;
        } catch (error) {
          if (this.cabIrRef.kind !== 'custom') throw error;
          activeIr = await this.cabIrResolver.resolve(ctx, { kind: 'builtin', id: 'gb4x12' });
          runtime.cabIrFallbackActive = true;
        }
        stageInitialCabIrBuffer(ctx, activeIr.buffer, activeIr.calibrationDb);
      }
      const plan = planGraph(this.graphSpec(), graphPrevState(runtime.graph));
      const artifacts = executePlan(
        ctx,
        { inputGain, inputAnalyser, outputAnalyser, looperNode },
        plan,
      );
      if (artifacts) applyArtifacts(runtime, artifacts);

      if (this.outputDeviceId !== 'default') {
        const sinkContext = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
        if (typeof sinkContext.setSinkId === 'function') await sinkContext.setSinkId(this.outputDeviceId);
      }
      return runtime;
    } catch (error) {
      await ctx.close().catch(() => undefined);
      throw error;
    }
  }

  private graphSpec() {
    return {
      chain: this.chain,
      amp: this.ampSpec,
      cab: this.cabSpec,
      globalBypass: this.globalBypass,
    };
  }

  private async disposeRuntime(runtime: AudioRuntime): Promise<void> {
    const instances = new Set<EffectInstance>();
    for (const entry of runtime.graph.instances.values()) instances.add(entry.inst);
    if (runtime.graph.ampInstance) instances.add(runtime.graph.ampInstance);
    if (runtime.graph.cabInstance) instances.add(runtime.graph.cabInstance);
    for (const instance of instances) {
      try {
        instance.dispose();
      } catch (error) {
        console.warn('旧 DSP 实例清理失败:', error);
      }
    }
    try {
      runtime.looperNode?.port.postMessage({ type: 'suspend' });
      if (runtime.looperNode) runtime.looperNode.port.onmessage = null;
      runtime.looperNode?.disconnect();
      runtime.inputGain.disconnect();
      runtime.outputAnalyser.disconnect();
      runtime.limiter.disconnect();
      runtime.masterGain.disconnect();
      runtime.metronomeBus.disconnect();
    } catch {
      /* Context 关闭过程中的重复断开可忽略 */
    }
    await runtime.ctx.close().catch(() => undefined);
  }

  private resetLooperForRuntime(runtime: AudioRuntime): void {
    this.looperStatus = runtime.looperNode
      ? { ...INITIAL_LOOPER_STATUS, available: true }
      : { ...INITIAL_LOOPER_STATUS };
    this.emitLooperStatus();
  }

  // ---------- 档位 / 诊断 ----------

  async switchAudioProfile(profile: AudioProfile): Promise<AudioProfileSwitchResult> {
    if (profile === this.profile) return { ok: true };
    const blocked = profileSwitchBlock(this.recording, this.looperStatus);
    if (blocked === 'recording') {
      return { ok: false, reason: 'recording', message: '录音进行中，停止录音后才能切换音频档位。' };
    }
    if (blocked === 'looper-not-empty') {
      return { ok: false, reason: 'looper-not-empty', message: 'Looper 非空，请先清空循环内容。' };
    }
    if (!this.runtime) {
      this.profile = profile;
      saveAudioProfile(profile);
      this.latencyWindow.clear();
      this.diagnostics = { ...emptyDiagnostics(profile), runtimeVersion: this.runtimeVersion };
      this.emitDiagnostics();
      return { ok: true };
    }

    const oldRuntime = this.runtime;
    const cabIrVersionAtStart = this.cabIrVersion;
    const oldSource = this.sourceNode;
    const oldDescriptor = this.inputDescriptor;
    let preparedSource: PreparedSource | null = null;
    try {
      await runRuntimeTransaction<AudioRuntime>({
        prepare: async () => {
          const candidate = await this.prepareRuntime(profile, true, true);
          try {
            preparedSource = await this.prepareSourceForRuntime(candidate, profile);
            return candidate;
          } catch (error) {
            await this.disposeRuntime(candidate);
            throw error;
          }
        },
        activate: async (candidate) => {
          oldSource?.disconnect();
          await candidate.ctx.resume();
        },
        commit: async (candidate) => {
          assertRuntimeRevision(
            cabIrVersionAtStart,
            this.cabIrVersion,
            '箱体 IR 在音频档位切换期间已变化，请重试',
          );
          this.runtime = candidate;
          this.profile = profile;
          saveAudioProfile(profile);
          this.sourceNode = preparedSource?.node ?? null;
          if (preparedSource?.descriptor) this.inputDescriptor = preparedSource.descriptor;
          if (preparedSource?.inputDegraded !== undefined) this.inputDegraded = preparedSource.inputDegraded;
          if (this.testTimer !== null) {
            window.clearInterval(this.testTimer);
            this.testTimer = null;
          }
          if (preparedSource?.startTimer) this.testTimer = preparedSource.startTimer();
          if (oldSource) this.disposeSourceNode(oldSource, false);
          if (oldDescriptor?.type === 'mic' && oldDescriptor !== preparedSource?.descriptor) {
            oldDescriptor.stream.getTracks().forEach((track) => track.stop());
          }
          this.runtimeVersion++;
          this.calibration = loadLoopbackCalibration();
          this.stabilityObservation = null;
          this.latencyWindow.clear();
          this.resetLooperForRuntime(candidate);
          this.startDiagnostics();
          await this.disposeRuntime(oldRuntime);
        },
        rollback: async (candidate) => {
          if (preparedSource) {
            this.disposeSourceNode(preparedSource.node, false);
            preparedSource.cleanup?.();
          }
          if (candidate) await this.disposeRuntime(candidate);
          try {
            if (oldSource) oldSource.connect(oldRuntime.inputGain);
          } catch {
            /* old source 从未断开或已重新连接 */
          }
          this.runtime = oldRuntime;
          this.sourceNode = oldSource;
          this.sampleDiagnostics();
        },
      });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: 'failed',
        message: `音频档位切换失败，已保留原档位：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  get currentDiagnostics(): AudioDiagnosticsSnapshot {
    return {
      ...this.diagnostics,
      workletFailures: [...this.diagnostics.workletFailures],
      outputEstimate: { ...this.diagnostics.outputEstimate },
      inputSettings: this.diagnostics.inputSettings ? { ...this.diagnostics.inputSettings } : null,
      playback: { ...this.diagnostics.playback },
      rigLatency: this.diagnostics.rigLatency
        ? { ...this.diagnostics.rigLatency, items: this.diagnostics.rigLatency.items.map((item) => ({ ...item })) }
        : null,
    };
  }

  subscribeDiagnostics(listener: (snapshot: AudioDiagnosticsSnapshot) => void): () => void {
    this.diagnosticsListeners.add(listener);
    listener(this.currentDiagnostics);
    return () => this.diagnosticsListeners.delete(listener);
  }

  private emitDiagnostics(): void {
    const snapshot = this.currentDiagnostics;
    for (const listener of this.diagnosticsListeners) listener(snapshot);
  }

  private startDiagnostics(): void {
    if (this.diagnosticsTimer !== null) window.clearInterval(this.diagnosticsTimer);
    this.latencyWindow.clear();
    this.sampleDiagnostics();
    this.diagnosticsTimer = window.setInterval(() => this.sampleDiagnostics(), 1000);
  }

  private sampleDiagnostics(): void {
    const runtime = this.runtime;
    if (!runtime) {
      this.diagnostics = { ...emptyDiagnostics(this.profile), runtimeVersion: this.runtimeVersion };
      this.emitDiagnostics();
      return;
    }
    const baseLatencyMs = finiteMs(runtime.ctx.baseLatency);
    const outputLatencyMs = finiteMs(
      (runtime.ctx as AudioContext & { outputLatency?: number }).outputLatency,
    );
    const estimateMs =
      baseLatencyMs !== null && outputLatencyMs !== null ? baseLatencyMs + outputLatencyMs : null;
    const outputEstimate = this.latencyWindow.push(estimateMs);
    if (estimateMs !== null) this.profileLatencies.set(this.profile, estimateMs);
    const profileIgnored =
      estimateMs !== null &&
      [...this.profileLatencies].some(
        ([profile, value]) => profile !== this.profile && Math.abs(value - estimateMs) < 0.1,
      );
    const inputSettings = this.currentMicTrack()?.getSettings() ?? null;
    const warnings: string[] = [];
    if (this.inputDegraded) warnings.push('输入设备忽略了部分低延迟/48k/mono 请求');
    if (runtime.ctx.sampleRate !== 48_000) warnings.push('实际采样率不是 48kHz，NAM 音色可能不准确');
    if (profileIgnored) warnings.push('浏览器未区分该音频档位');
    const workletFailures = WORKLETS.filter((entry) => !runtime.loadedWorklets.has(entry.label)).map((entry) => entry.label);
    if (workletFailures.length > 0) warnings.push('部分 DSP Worklet 未加载，相关模块可能安全直通');
    const calibrationKey = this.currentCalibrationKey();
    this.diagnostics = {
      ready: true,
      runtimeVersion: this.runtimeVersion,
      profile: this.profile,
      profileIgnored,
      degradedInput: this.inputDegraded,
      workletFailures,
      warning: warnings.length > 0 ? warnings.join('；') : null,
      baseLatencyMs,
      outputLatencyMs,
      outputEstimate,
      sampleRate: runtime.ctx.sampleRate,
      inputSettings,
      playback: readPlaybackStats(runtime.ctx),
      mainThread: this.longTasks.snapshot(),
      stabilityObservation: this.stabilityObservation,
      rigLatency: calculateRigLatency(this.graphSpec(), runtime.ctx.sampleRate),
      calibrationMs:
        calibrationKey && calibrationMatches(this.calibration, calibrationKey)
          ? this.calibration!.delayMs
          : null,
    };
    this.emitDiagnostics();
  }

  /** 观察当前 Rig；长任务是代理指标，underrun 只读取浏览器明确统计。 */
  async runStabilityObservation(durationMs = 10_000): Promise<StabilityObservation> {
    if (!this.runtime) throw new Error('请先启动一个输入源');
    const duration = Math.max(1_000, Math.min(30 * 60_000, durationMs));
    const mainBefore = this.longTasks.snapshot();
    const playbackBefore = readPlaybackStats(this.runtime.ctx);
    await new Promise<void>((resolve) => window.setTimeout(resolve, duration));
    const runtime = this.runtime;
    if (!runtime) throw new Error('观察期间音频运行时已关闭');
    const mainAfter = this.longTasks.snapshot();
    const playbackAfter = readPlaybackStats(runtime.ctx);
    const observation: StabilityObservation = {
      measuredAt: new Date().toISOString(),
      durationMs: duration,
      longTaskCount: mainAfter.supported ? mainAfter.longTaskCount - mainBefore.longTaskCount : null,
      longTaskDurationMs: mainAfter.supported ? mainAfter.longTaskDurationMs - mainBefore.longTaskDurationMs : null,
      underrunEvents: playbackAfter.supported && playbackAfter.underrunEvents !== null && playbackBefore.underrunEvents !== null ? playbackAfter.underrunEvents - playbackBefore.underrunEvents : null,
      underrunDurationMs: playbackAfter.supported && playbackAfter.underrunDurationMs !== null && playbackBefore.underrunDurationMs !== null ? playbackAfter.underrunDurationMs - playbackBefore.underrunDurationMs : null,
    };
    this.stabilityObservation = observation;
    this.sampleDiagnostics();
    return observation;
  }

  // ---------- 输入 / 输出 ----------

  setInputGain(value: number): void {
    this.inputGainValue = value;
    const runtime = this.runtime;
    if (runtime) runtime.inputGain.gain.setTargetAtTime(value, runtime.ctx.currentTime, 0.02);
  }

  setMasterVolume(value: number): void {
    this.masterVolumeValue = value;
    const runtime = this.runtime;
    if (runtime) runtime.masterGain.gain.setTargetAtTime(value, runtime.ctx.currentTime, 0.02);
  }

  private currentMicTrack(): MediaStreamTrack | null {
    return this.inputDescriptor?.type === 'mic'
      ? (this.inputDescriptor.stream.getAudioTracks()[0] ?? null)
      : null;
  }

  private currentCalibrationKey(): LoopbackCalibrationKey | null {
    const runtime = this.runtime;
    const descriptor = this.inputDescriptor;
    if (!runtime || descriptor?.type !== 'mic') return null;
    return {
      inputDeviceId:
        this.currentMicTrack()?.getSettings().deviceId ?? descriptor.deviceId ?? 'default',
      outputDeviceId: this.outputDeviceId,
      sampleRate: runtime.ctx.sampleRate,
      profile: this.profile,
      browserMajor: browserMajor(),
      osAudioConfig: osAudioConfig(),
    };
  }

  private disposeSourceNode(node: AudioNode, stopTrack: boolean): void {
    try {
      (node as AudioBufferSourceNode).stop?.();
    } catch {
      /* 已停止或不是可停止节点 */
    }
    try {
      node.disconnect();
    } catch {
      /* 已断开 */
    }
    if (stopTrack && this.inputDescriptor?.type === 'mic') {
      this.inputDescriptor.stream.getTracks().forEach((track) => track.stop());
    }
  }

  private stopSource(): void {
    if (this.testTimer !== null) {
      window.clearInterval(this.testTimer);
      this.testTimer = null;
    }
    if (this.sourceNode) this.disposeSourceNode(this.sourceNode, true);
    this.sourceNode = null;
    this.inputDescriptor = null;
    this.inputDegraded = false;
    this.calibration = null;
    this.stabilityObservation = null;
    this.latencyWindow.clear();
    this.profileLatencies.clear();
    this.sampleDiagnostics();
  }

  async useMic(deviceId?: string): Promise<void> {
    await this.init();
    const { stream, degraded } = await this.requestMic(this.profile, deviceId);
    const runtime = this.runtime!;
    let node: MediaStreamAudioSourceNode;
    try {
      node = runtime.ctx.createMediaStreamSource(stream);
      node.connect(runtime.inputGain);
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      throw error;
    }
    this.stopSource();
    this.inputDescriptor = { type: 'mic', ...(deviceId ? { deviceId } : {}), stream };
    this.sourceNode = node;
    this.inputDegraded = degraded;
    this.calibration = loadLoopbackCalibration();
    this.stabilityObservation = null;
    this.latencyWindow.clear();
    this.sampleDiagnostics();
  }

  private async requestMic(profile: AudioProfile, deviceId?: string): Promise<{ stream: MediaStream; degraded: boolean }> {
    return openMicWithFallback(this.getUserMedia, profile, deviceId);
  }

  async useFile(file: File): Promise<void> {
    await this.init();
    const runtime = this.runtime!;
    const buffer = await runtime.ctx.decodeAudioData(await file.arrayBuffer());
    const source = runtime.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(runtime.inputGain);
    source.start();
    this.stopSource();
    this.inputDescriptor = { type: 'file', file };
    this.sourceNode = source;
    this.stabilityObservation = null;
    this.latencyWindow.clear();
    this.sampleDiagnostics();
  }

  async useTestTone(): Promise<void> {
    await this.init();
    const runtime = this.runtime!;
    try {
      const url = `${import.meta.env.BASE_URL}samples/guitar-riff.wav`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await runtime.ctx.decodeAudioData(await response.arrayBuffer());
      const source = runtime.ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(runtime.inputGain);
      source.start();
      this.stopSource();
      this.inputDescriptor = { type: 'test' };
      this.sourceNode = source;
    } catch (error) {
      console.warn('吉他 riff 采样加载失败，回退到合成 riff:', error);
      this.stopSource();
      this.inputDescriptor = { type: 'test' };
      const prepared = this.createSynthSource(runtime);
      this.sourceNode = prepared.node;
      this.testTimer = prepared.startTimer!();
    }
    this.stabilityObservation = null;
    this.latencyWindow.clear();
    this.sampleDiagnostics();
  }

  private createSynthSource(runtime: AudioRuntime): PreparedSource {
    const bus = runtime.ctx.createGain();
    bus.connect(runtime.inputGain);
    return {
      node: bus,
      startTimer: () => {
        const notes = [110, 130.81, 146.83, 164.81, 196, 220, 196, 164.81];
        let step = 0;
        const playNote = () => {
          const time = runtime.ctx.currentTime;
          const oscillator = runtime.ctx.createOscillator();
          oscillator.type = 'sawtooth';
          oscillator.frequency.value = notes[step % notes.length];
          step++;
          const lowpass = runtime.ctx.createBiquadFilter();
          lowpass.type = 'lowpass';
          lowpass.frequency.value = 1400;
          const gain = runtime.ctx.createGain();
          gain.gain.setValueAtTime(0.0001, time);
          gain.gain.exponentialRampToValueAtTime(0.22, time + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.26);
          oscillator.connect(lowpass);
          lowpass.connect(gain);
          gain.connect(bus);
          oscillator.start(time);
          oscillator.stop(time + 0.28);
        };
        playNote();
        return window.setInterval(playNote, 300);
      },
    };
  }

  private async prepareSourceForRuntime(runtime: AudioRuntime, profile: AudioProfile): Promise<PreparedSource | null> {
    const descriptor = this.inputDescriptor;
    if (!descriptor) return null;
    if (descriptor.type === 'mic') {
      const { stream, degraded } = await this.requestMic(profile, descriptor.deviceId);
      try {
        const node = runtime.ctx.createMediaStreamSource(stream);
        node.connect(runtime.inputGain);
        return {
          node,
          descriptor: { type: 'mic', ...(descriptor.deviceId ? { deviceId: descriptor.deviceId } : {}), stream },
          inputDegraded: degraded,
          cleanup: () => stream.getTracks().forEach((track) => track.stop()),
        };
      } catch (error) {
        stream.getTracks().forEach((track) => track.stop());
        throw error;
      }
    }
    if (descriptor.type === 'file') {
      const buffer = await runtime.ctx.decodeAudioData(await descriptor.file.arrayBuffer());
      const source = runtime.ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(runtime.inputGain);
      source.start();
      return { node: source };
    }
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}samples/guitar-riff.wav`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await runtime.ctx.decodeAudioData(await response.arrayBuffer());
      const source = runtime.ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(runtime.inputGain);
      source.start();
      return { node: source };
    } catch {
      return this.createSynthSource(runtime);
    }
  }

  stopInput(): void {
    this.stopSource();
  }

  async setOutputDevice(deviceId: string): Promise<boolean> {
    this.outputDeviceId = deviceId;
    this.calibration = loadLoopbackCalibration();
    this.stabilityObservation = null;
    if (!this.runtime) return false;
    const ctx = this.runtime.ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (typeof ctx.setSinkId !== 'function') return false;
    await ctx.setSinkId(deviceId);
    this.latencyWindow.clear();
    this.profileLatencies.clear();
    this.sampleDiagnostics();
    return true;
  }

  // ---------- 输出录音 ----------

  get recording(): boolean {
    return this.mediaRecorder !== null;
  }

  startRecording(): boolean {
    const recorderDest = this.runtime?.recorderDest;
    if (!recorderDest || this.mediaRecorder) return false;
    let mimeType = '';
    for (const type of ['audio/webm;codecs=opus', 'audio/webm']) {
      if (MediaRecorder.isTypeSupported(type)) {
        mimeType = type;
        break;
      }
    }
    const recorder = new MediaRecorder(recorderDest.stream, mimeType ? { mimeType } : undefined);
    this.recordChunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.recordChunks.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(this.recordChunks, { type: recorder.mimeType || 'audio/webm' });
      this.recordChunks = [];
      this.mediaRecorder = null;
      this.downloadRecording(blob);
    };
    recorder.start(1000);
    this.mediaRecorder = recorder;
    return true;
  }

  stopRecording(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop();
  }

  private downloadRecording(blob: Blob): void {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `guitar-pedalboard-${stamp}.webm`;
    link.click();
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
    const sampleRate = this.runtime?.ctx.sampleRate ?? 48_000;
    const lengthSamples = typeof message.lengthSamples === 'number' ? message.lengthSamples : 0;
    const positionSamples = typeof message.positionSamples === 'number' ? message.positionSamples : 0;
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
    const node = this.runtime?.looperNode;
    if (!node || !canRunLooperCommand(this.looperStatus, command)) return false;
    node.port.postMessage({ type: command });
    return true;
  }

  startLoopRecording(): boolean { return this.sendLooperCommand('record'); }
  finishLoopRecording(): boolean { return this.sendLooperCommand('finish-record'); }
  startLoopOverdub(): boolean { return this.sendLooperCommand('overdub'); }
  finishLoopOverdub(): boolean { return this.sendLooperCommand('finish-overdub'); }
  toggleLoopPlayback(): boolean { return this.sendLooperCommand('toggle-play'); }
  undoLoopOverdub(): boolean { return this.sendLooperCommand('undo'); }
  clearLoop(): boolean { return this.sendLooperCommand('clear'); }

  setLoopLevel(value: number): void {
    this.runtime?.looperNode?.port.postMessage({
      type: 'set-level',
      value: Math.max(0, Math.min(1.5, value)),
    });
  }

  // ---------- 电气回环校准 ----------

  async runLoopbackCalibration(): Promise<LoopbackAnalysis> {
    const runtime = this.runtime;
    const descriptor = this.inputDescriptor;
    const source = this.sourceNode;
    if (!runtime || !source || descriptor?.type !== 'mic') {
      return { ok: false, delaySamples: null, delayMs: null, confidence: 0, peak: 0, reason: 'invalid' };
    }
    if (this.recording || this.looperStatus.phase !== 'empty') {
      return { ok: false, delaySamples: null, delayMs: null, confidence: 0, peak: 0, reason: 'invalid' };
    }

    const reference = createLoopbackSequence();
    const leadFrames = Math.round(runtime.ctx.sampleRate * 0.25);
    const captureFrames = Math.round(runtime.ctx.sampleRate * 1.25);
    const probe = new AudioWorkletNode(runtime.ctx, 'loopback-probe', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    source.disconnect();
    source.connect(probe);
    probe.connect(runtime.ctx.destination);
    try {
      const captured = await new Promise<Float32Array>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('回环校准超时')), 3000);
        probe.port.onmessage = (event: MessageEvent<unknown>) => {
          const message = event.data as { type?: string; captured?: ArrayBuffer };
          if (message.type !== 'complete' || !message.captured) return;
          window.clearTimeout(timeout);
          resolve(new Float32Array(message.captured));
        };
        const copy = reference.slice();
        probe.port.postMessage(
          {
            type: 'start',
            sequence: copy.buffer,
            leadFrames,
            captureFrames,
            level: 10 ** (-30 / 20),
          },
          [copy.buffer],
        );
      });
      const raw = analyzeLoopback(captured, reference, runtime.ctx.sampleRate);
      if (!raw.ok || raw.delaySamples === null) return raw;
      const delaySamples = raw.delaySamples - leadFrames;
      if (delaySamples < 0) {
        return { ok: false, delaySamples: null, delayMs: null, confidence: 0, peak: raw.peak, reason: 'ambiguous' };
      }
      const result: LoopbackAnalysis = {
        ...raw,
        delaySamples,
        delayMs: (delaySamples / runtime.ctx.sampleRate) * 1000,
      };
      this.calibration = {
        key: this.currentCalibrationKey()!,
        delayMs: result.delayMs!,
        confidence: result.confidence,
        measuredAt: new Date().toISOString(),
      };
      saveLoopbackCalibration(this.calibration);
      this.sampleDiagnostics();
      return result;
    } finally {
      probe.port.onmessage = null;
      probe.disconnect();
      source.disconnect();
      source.connect(runtime.inputGain);
    }
  }

  // ---------- 效果链 ----------

  setGlobalBypass(bypass: boolean): void {
    this.globalBypass = bypass;
    this.rebuildGraph();
  }

  setChain(chain: ChainSpec[]): void {
    this.chain = chain;
    this.rebuildGraph();
  }

  updateParam(uid: string, key: string, value: number): void {
    this.runtime?.graph.instances.get(uid)?.inst.update(key, value);
    const spec = this.chain.find((item) => item.uid === uid);
    if (spec) spec.values = { ...spec.values, [key]: value };
    this.sampleDiagnostics();
  }

  getModuleAnalyser(uid: string): AnalyserNode | null {
    return this.runtime?.graph.moduleAnalysers.get(uid) ?? null;
  }

  setAmp(spec: AmpSpec | null): void {
    this.ampSpec = spec;
    this.rebuildGraph();
  }

  updateAmpParam(key: string, value: number): void {
    this.runtime?.graph.ampInstance?.update(key, value);
    if (this.ampSpec) this.ampSpec = { ...this.ampSpec, values: { ...this.ampSpec.values, [key]: value } };
    this.sampleDiagnostics();
  }

  setCab(spec: CabSpec | null): void {
    this.cabSpec = spec;
    if (spec?.irRef && cabIrRefKey(spec.irRef) !== cabIrRefKey(this.cabIrRef)) {
      this.cabIrRef = spec.irRef;
      this.cabIrVersion++;
    }
    this.rebuildGraph();
  }

  /** 为当前 context 解码/缓存候选 IR，不改变当前听感或 canonical Rig。 */
  async prepareCabIr(ref: CabIrRef, source?: unknown): Promise<PreparedCabIrBuffer> {
    const runtime = this.runtime;
    if (!runtime) throw new Error('请先启动音频输入');
    const resolved = await this.cabIrResolver.resolve(runtime.ctx, ref, source);
    return { context: runtime.ctx, ref, ...resolved };
  }

  setCabIrCustomLoader(
    loader: (hash: string) => Promise<import('./cabIrCoordinator').StoredCabIr | null>,
    saveCalibration?: (hash: string, calibrationDb: number) => Promise<void>,
  ): void {
    this.cabIrResolver.setCustomLoader(loader, saveCalibration);
  }

  get isCabIrFallbackActive(): boolean {
    return this.runtime?.cabIrFallbackActive ?? false;
  }

  /** prepare 成功后的同步提交；迟到的旧 context 候选不会覆盖新 Runtime。 */
  activatePreparedCabIr(prepared: PreparedCabIrBuffer, canonicalRef = prepared.ref): void {
    const runtime = this.runtime;
    if (!runtime || runtime.ctx !== prepared.context) throw new Error('音频 Runtime 已变化，请重试');
    const instance = runtime.graph.cabInstance;
    stageInitialCabIrBuffer(runtime.ctx, prepared.buffer, prepared.calibrationDb);
    if (instance && !isCabIrEffectInstance(instance)) throw new Error('箱体 IR Runtime 类型无效');
    if (isCabIrEffectInstance(instance)) instance.switchBuffer(prepared.buffer, prepared.calibrationDb);
    this.cabIrRef = canonicalRef;
    this.cabIrVersion++;
    runtime.cabIrFallbackActive = cabIrRefKey(canonicalRef) !== cabIrRefKey(prepared.ref);
  }

  updateCabParam(key: string, value: number): void {
    this.runtime?.graph.cabInstance?.update(key, value);
    if (this.cabSpec) this.cabSpec = { ...this.cabSpec, values: { ...this.cabSpec.values, [key]: value } };
    this.sampleDiagnostics();
  }

  private rebuildGraph(): void {
    const runtime = this.runtime;
    if (!runtime) return;
    const plan = planGraph(this.graphSpec(), graphPrevState(runtime.graph));
    const artifacts = executePlan(
      runtime.ctx,
      {
        inputGain: runtime.inputGain,
        inputAnalyser: runtime.inputAnalyser,
        outputAnalyser: runtime.outputAnalyser,
        looperNode: runtime.looperNode,
      },
      plan,
    );
    if (artifacts) applyArtifacts(runtime, artifacts);
    this.sampleDiagnostics();
  }
}

export const audioEngine = new AudioEngine();

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__audioEngine = audioEngine;
}
