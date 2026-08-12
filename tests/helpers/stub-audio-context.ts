/**
 * Web Audio 测试替身(stub AudioContext)。
 *
 * 用途:在 `tsx --test` 下无浏览器地断言音频图行为。
 * 记录三类事实,供测试断言:
 *   1. 节点创建:每个节点的类型(kind)、构造名(worklet)、创建顺序(id);
 *   2. 图结构:connect/disconnect 事件与当前存活连接(含连到 AudioParam 的调制边);
 *   3. 参数调用:`param.value` 赋值与 setValueAtTime/setTargetAtTime 等调度调用(含参数)。
 *
 * 典型用法(经过 EffectDefinition 接口):
 *   const ctx = createStubAudioContext();
 *   const inst = someEffect.create(ctx as unknown as AudioContext);
 *   assert.equal(ctx.nodesOfKind('WaveShaperNode').length, 1);
 *
 * 注意:效果代码里 `new AudioWorkletNode(...)` 引用的是全局构造器,
 * createStubAudioContext() 会把全局 AudioWorkletNode 指到 StubAudioWorkletNode。
 */

/** AudioParam 上被记录的方法名;setValue 表示 `param.value = x` 赋值 */
export type StubParamMethod =
  | 'setValue'
  | 'setValueAtTime'
  | 'setTargetAtTime'
  | 'linearRampToValueAtTime'
  | 'exponentialRampToValueAtTime'
  | 'cancelScheduledValues';

export interface StubParamCall {
  method: StubParamMethod;
  args: number[];
}

/** AudioParam 替身:记录每次 value 赋值与调度调用 */
export class StubAudioParam {
  /** 所属节点;worklet 自由参数为所属的 worklet 节点 */
  readonly owner: StubAudioNode | null;
  /** 参数名,如 'gain'、'frequency'、'mix' */
  readonly name: string;
  /** 全部调用记录(含 value 赋值),按发生顺序 */
  readonly calls: StubParamCall[] = [];
  private currentValue: number;

  constructor(name: string, defaultValue = 0, owner: StubAudioNode | null = null) {
    this.name = name;
    this.owner = owner;
    this.currentValue = defaultValue;
  }

  get value(): number {
    return this.currentValue;
  }

  set value(v: number) {
    this.currentValue = v;
    this.calls.push({ method: 'setValue', args: [v] });
  }

  setValueAtTime(value: number, startTime: number): void {
    this.currentValue = value;
    this.calls.push({ method: 'setValueAtTime', args: [value, startTime] });
  }

  setTargetAtTime(target: number, startTime: number, timeConstant: number): void {
    this.currentValue = target;
    this.calls.push({ method: 'setTargetAtTime', args: [target, startTime, timeConstant] });
  }

  linearRampToValueAtTime(value: number, endTime: number): void {
    this.currentValue = value;
    this.calls.push({ method: 'linearRampToValueAtTime', args: [value, endTime] });
  }

  exponentialRampToValueAtTime(value: number, endTime: number): void {
    this.currentValue = value;
    this.calls.push({ method: 'exponentialRampToValueAtTime', args: [value, endTime] });
  }

  cancelScheduledValues(cancelTime: number): void {
    this.calls.push({ method: 'cancelScheduledValues', args: [cancelTime] });
  }

  /** 只取某类方法的调用,如 param.callsOf('setTargetAtTime') */
  callsOf(method: StubParamMethod): StubParamCall[] {
    return this.calls.filter((c) => c.method === method);
  }
}

/** 一条连接记录:to 为节点(音频边)或 AudioParam(调制边,如 LFO → delay.delayTime) */
export interface StubConnection {
  from: StubAudioNode;
  to: StubAudioNode | StubAudioParam;
}

/** connect/disconnect 事件,用于断言 dispose 等断开行为 */
export interface StubConnectionEvent {
  type: 'connect' | 'disconnect';
  from: StubAudioNode;
  to: StubAudioNode | StubAudioParam | null;
}

/** AudioNode 替身基类:登记到 context,记录连接 */
export class StubAudioNode {
  readonly context: StubAudioContext;
  /** 节点类型,如 'GainNode'、'BiquadFilterNode'、'AudioWorkletNode' */
  readonly kind: string;
  /** 创建序号(同一 context 内从 1 递增,destination 固定为 1) */
  readonly id: number;

  constructor(context: StubAudioContext, kind: string) {
    this.context = context;
    this.kind = kind;
    this.id = context.registerNode(this);
  }

  connect(destination: StubAudioNode | StubAudioParam): StubAudioNode | undefined {
    this.context.recordConnect(this, destination);
    return destination instanceof StubAudioNode ? destination : undefined;
  }

  disconnect(): void;
  disconnect(destination: StubAudioNode | StubAudioParam): void;
  disconnect(destination?: StubAudioNode | StubAudioParam): void {
    this.context.recordDisconnect(this, destination);
  }

  /** 便捷:在该节点上挂一个记录型参数 */
  protected addParam(name: string, defaultValue: number): StubAudioParam {
    return new StubAudioParam(name, defaultValue, this);
  }
}

export class StubGainNode extends StubAudioNode {
  readonly gain = this.addParam('gain', 1);
  constructor(context: StubAudioContext) {
    super(context, 'GainNode');
  }
}

export class StubBiquadFilterNode extends StubAudioNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = this.addParam('frequency', 350);
  readonly Q = this.addParam('Q', 1);
  readonly gain = this.addParam('gain', 0);
  readonly detune = this.addParam('detune', 0);
  constructor(context: StubAudioContext) {
    super(context, 'BiquadFilterNode');
  }
}

export class StubWaveShaperNode extends StubAudioNode {
  curve: Float32Array | null = null;
  oversample: OverSampleType = 'none';
  constructor(context: StubAudioContext) {
    super(context, 'WaveShaperNode');
  }
}

export class StubOscillatorNode extends StubAudioNode {
  type: OscillatorType = 'sine';
  readonly frequency = this.addParam('frequency', 440);
  readonly detune = this.addParam('detune', 0);
  readonly startCalls: number[] = [];
  readonly stopCalls: number[] = [];
  onended: (() => void) | null = null;
  constructor(context: StubAudioContext) {
    super(context, 'OscillatorNode');
  }
  start(when = 0): void {
    this.startCalls.push(when);
  }
  stop(when = 0): void {
    this.stopCalls.push(when);
  }
}

export class StubAnalyserNode extends StubAudioNode {
  fftSize = 2048;
  minDecibels = -100;
  maxDecibels = -30;
  smoothingTimeConstant = 0.8;
  constructor(context: StubAudioContext) {
    super(context, 'AnalyserNode');
  }
  get frequencyBinCount(): number {
    return this.fftSize / 2;
  }
  getFloatTimeDomainData(array: Float32Array): void {
    array.fill(0);
  }
  getByteTimeDomainData(array: Uint8Array): void {
    array.fill(128);
  }
  getFloatFrequencyData(array: Float32Array): void {
    array.fill(this.minDecibels);
  }
  getByteFrequencyData(array: Uint8Array): void {
    array.fill(0);
  }
}

export class StubDelayNode extends StubAudioNode {
  readonly delayTime = this.addParam('delayTime', 0);
  readonly maxDelay: number;
  constructor(context: StubAudioContext, maxDelay = 1) {
    super(context, 'DelayNode');
    this.maxDelay = maxDelay;
  }
}

export class StubDynamicsCompressorNode extends StubAudioNode {
  readonly threshold = this.addParam('threshold', -24);
  readonly knee = this.addParam('knee', 30);
  readonly ratio = this.addParam('ratio', 12);
  readonly attack = this.addParam('attack', 0.003);
  readonly release = this.addParam('release', 0.25);
  constructor(context: StubAudioContext) {
    super(context, 'DynamicsCompressorNode');
  }
}

export class StubStereoPannerNode extends StubAudioNode {
  readonly pan = this.addParam('pan', 0);
  constructor(context: StubAudioContext) {
    super(context, 'StereoPannerNode');
  }
}

export class StubConvolverNode extends StubAudioNode {
  buffer: StubAudioBuffer | null = null;
  normalize = true;
  constructor(context: StubAudioContext) {
    super(context, 'ConvolverNode');
  }
}

export class StubAudioBufferSourceNode extends StubAudioNode {
  buffer: StubAudioBuffer | null = null;
  loop = false;
  readonly playbackRate = this.addParam('playbackRate', 1);
  readonly startCalls: number[] = [];
  readonly stopCalls: number[] = [];
  onended: (() => void) | null = null;
  constructor(context: StubAudioContext) {
    super(context, 'AudioBufferSourceNode');
  }
  start(when = 0): void {
    this.startCalls.push(when);
  }
  stop(when = 0): void {
    this.stopCalls.push(when);
  }
}

export class StubMediaStreamDestinationNode extends StubAudioNode {
  readonly stream = {} as MediaStream;
  constructor(context: StubAudioContext) {
    super(context, 'MediaStreamDestinationNode');
  }
}

export class StubMediaStreamAudioSourceNode extends StubAudioNode {
  readonly mediaStream: MediaStream;
  constructor(context: StubAudioContext, mediaStream: MediaStream) {
    super(context, 'MediaStreamAudioSourceNode');
    this.mediaStream = mediaStream;
  }
}

/** AudioBuffer 替身:getChannelData 返回真实可写的 Float32Array(脉冲响应等代码会写入) */
export class StubAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  private readonly channels: Float32Array[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }
}

/**
 * worklet 节点 options 替身类型。
 * 不用 DOM 的 AudioWorkletNodeOptions:TS 的 DOM lib 里没有 parameterDescriptors
 * 字段(非标准但浏览器/本仓库都在用),这里自带一份结构类型。
 */
export interface StubWorkletParamDescriptor {
  name: string;
  defaultValue?: number;
  minValue?: number;
  maxValue?: number;
}

export interface StubAudioWorkletNodeOptions {
  numberOfInputs?: number;
  numberOfOutputs?: number;
  outputChannelCount?: number[];
  parameterDescriptors?: StubWorkletParamDescriptor[];
}

/**
 * worklet 参数表:真实 AudioParamMap 只含 processor 声明的参数,
 * 替身不加载 processor,故 get() 对未知参数惰性创建——
 * 这让 effect.update(key, value) 的参数调用总能被记录(包括传错 key 的情况)。
 */
class StubAudioParamMap {
  private readonly params = new Map<string, StubAudioParam>();

  constructor(owner: StubAudioWorkletNode, descriptors?: StubWorkletParamDescriptor[]) {
    for (const d of descriptors ?? []) {
      this.params.set(d.name, new StubAudioParam(d.name, d.defaultValue ?? 0, owner));
    }
  }

  get(name: string): StubAudioParam | undefined {
    let p = this.params.get(name);
    if (!p) {
      p = new StubAudioParam(name, 0, null);
      this.params.set(name, p);
    }
    return p;
  }

  entries(): IterableIterator<[string, StubAudioParam]> {
    return this.params.entries();
  }
}

/** MessagePort 替身:记录 postMessage 的全部消息 */
export class StubMessagePort {
  readonly messages: unknown[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage(message: unknown): void {
    this.messages.push(message);
  }
}

/** AudioWorkletNode 替身:额外记录构造名(processor 名)与 options */
export class StubAudioWorkletNode extends StubAudioNode {
  readonly processorName: string;
  readonly options: StubAudioWorkletNodeOptions;
  readonly parameters: StubAudioParamMap;
  readonly port = new StubMessagePort();
  onprocessorerror: ((event: Event) => void) | null = null;

  constructor(context: StubAudioContext, name: string, options: StubAudioWorkletNodeOptions = {}) {
    super(context, 'AudioWorkletNode');
    this.processorName = name;
    this.options = options;
    this.parameters = new StubAudioParamMap(this, options.parameterDescriptors);
  }
}

/** AudioWorkletGlobalScope 侧的 addModule 替身:记录加载过的模块 URL */
export class StubAudioWorklet {
  readonly addedModules: string[] = [];
  addModule(moduleURL: string): Promise<void> {
    this.addedModules.push(moduleURL);
    return Promise.resolve();
  }
}

/** AudioContext 替身:创建各类节点并集中记录图结构与参数调用 */
export class StubAudioContext {
  readonly sampleRate: number;
  /** 测试可自行推进,如 ctx.currentTime = 1.5 */
  currentTime = 0;
  state: AudioContextState = 'running';
  readonly destination: StubAudioNode;
  readonly audioWorklet = new StubAudioWorklet();

  /** 创建过的全部节点(含 destination,id=1),按创建顺序 */
  readonly nodes: StubAudioNode[] = [];
  /** connect/disconnect 全事件日志 */
  readonly connectionLog: StubConnectionEvent[] = [];
  /** 当前存活连接 */
  readonly connections: StubConnection[] = [];

  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.destination = new StubAudioNode(this, 'AudioDestinationNode');
  }

  /** @internal 节点构造时登记,返回创建序号 */
  registerNode(node: StubAudioNode): number {
    this.nodes.push(node);
    return this.nodes.length;
  }

  /** @internal */
  recordConnect(from: StubAudioNode, to: StubAudioNode | StubAudioParam): void {
    this.connections.push({ from, to });
    this.connectionLog.push({ type: 'connect', from, to });
  }

  /** @internal */
  recordDisconnect(from: StubAudioNode, to?: StubAudioNode | StubAudioParam): void {
    for (let i = this.connections.length - 1; i >= 0; i--) {
      const c = this.connections[i];
      if (c.from === from && (to === undefined || c.to === to)) {
        this.connections.splice(i, 1);
      }
    }
    this.connectionLog.push({ type: 'disconnect', from, to: to ?? null });
  }

  /** 按类型取节点,如 ctx.nodesOfKind('GainNode') */
  nodesOfKind<T extends StubAudioNode = StubAudioNode>(kind: string): T[] {
    return this.nodes.filter((n) => n.kind === kind) as T[];
  }

  /** 是否存活着 from → to 的连接(包括到 AudioParam 的调制边) */
  isConnected(from: StubAudioNode, to: StubAudioNode | StubAudioParam): boolean {
    return this.connections.some((c) => c.from === from && c.to === to);
  }

  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    this.state = 'suspended';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }

  createGain(): StubGainNode {
    return new StubGainNode(this);
  }

  createBiquadFilter(): StubBiquadFilterNode {
    return new StubBiquadFilterNode(this);
  }

  createWaveShaper(): StubWaveShaperNode {
    return new StubWaveShaperNode(this);
  }

  createOscillator(): StubOscillatorNode {
    return new StubOscillatorNode(this);
  }

  createAnalyser(): StubAnalyserNode {
    return new StubAnalyserNode(this);
  }

  createDelay(maxDelay?: number): StubDelayNode {
    return new StubDelayNode(this, maxDelay);
  }

  createDynamicsCompressor(): StubDynamicsCompressorNode {
    return new StubDynamicsCompressorNode(this);
  }

  createStereoPanner(): StubStereoPannerNode {
    return new StubStereoPannerNode(this);
  }

  createConvolver(): StubConvolverNode {
    return new StubConvolverNode(this);
  }

  createBufferSource(): StubAudioBufferSourceNode {
    return new StubAudioBufferSourceNode(this);
  }

  createMediaStreamDestination(): StubMediaStreamDestinationNode {
    return new StubMediaStreamDestinationNode(this);
  }

  createMediaStreamSource(mediaStream: MediaStream): StubMediaStreamAudioSourceNode {
    return new StubMediaStreamAudioSourceNode(this, mediaStream);
  }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): StubAudioBuffer {
    return new StubAudioBuffer(numberOfChannels, length, sampleRate);
  }
}

/**
 * 创建 stub context,并把全局 AudioWorkletNode 指向替身
 * (效果代码通过全局构造器 new AudioWorkletNode(...),不走 ctx 工厂方法)。
 */
export function createStubAudioContext(options?: { sampleRate?: number }): StubAudioContext {
  (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = StubAudioWorkletNode;
  return new StubAudioContext(options?.sampleRate);
}
