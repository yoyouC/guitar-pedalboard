/** 单个可调参数的描述 */
export interface ParamDef {
  /** 参数唯一键,update(key, value) 用它寻址 */
  key: string;
  /** UI 显示名 */
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  /** 单位后缀,如 'ms'、'Hz'、'dB'、'%',可选 */
  unit?: string;
}

/**
 * 一个已实例化的效果器。
 * 约定:input/output 均为 GainNode,外部按 prev.connect(input) / output.connect(next) 串联。
 * update() 应尽量使用 setTargetAtTime 平滑,避免爆音。
 * dispose() 必须停止内部 LFO/定时器并断开所有内部节点。
 */
export interface EffectInstance {
  input: GainNode;
  output: GainNode;
  update(key: string, value: number): void;
  dispose(): void;
}

/** 当前模块直接监听路径的确定性时延；处理时延与效果设计延迟分开统计。 */
export interface EffectLatency {
  processingSamples: number;
  designSamples: number;
}

/** 效果器定义(目录项),UI 用 params 自动渲染旋钮 */
export interface EffectDefinition {
  /** 唯一 id,如 'overdrive',同时是文件名(不含扩展名) */
  id: string;
  /** 显示名,如 'Overdrive' */
  name: string;
  /** 单块外观颜色(hex),如 '#e07020' */
  color: string;
  params: ParamDef[];
  /** 缺省为零；动态效果可按当前参数与实际采样率计算。 */
  latency?: EffectLatency | ((values: Record<string, number>, sampleRate: number) => EffectLatency);
  create(ctx: AudioContext): EffectInstance;
}
