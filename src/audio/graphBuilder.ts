import type { EffectDefinition, EffectInstance } from './effects/types';

/**
 * 图谱编译的 functional core / imperative shell(ADR-0005):
 *
 *   planGraph(spec, prevState) → GraphPlan   纯函数,零 WebAudio 依赖。
 *     只做决策:哪些实例创建/复用/销毁、保留实例回放哪些参数。
 *     不含连线描述,不调用 def.create(NAM 只比对 def+key)。
 *     spec 无结构变化 → 空 plan。
 *
 *   executePlan(ctx, env, plan) → GraphArtifacts   薄执行。
 *     按固定线性规则创建节点与接线:
 *       inputGain → 前置链 → preAmp tap → 箱头 → FX Loop 后置链 → 箱体 → looper/output
 *     空 plan 直接 no-op(返回 null),不触碰任何状态。
 *     NAM 的 fetch/模型缓存等模块级副作用只允许在这一层被触达(经 def.create)。
 *
 * 复用契约(与旧 rebuildGraph 逐条对应,行为零变化):
 *   - 单块:uid+def 相同且启用 → 复用(保住已加载模型与 LFO/延迟状态);
 *   - 箱头:def+key 相同且启用 → 复用(避免 NAM 模型重复加载,这是契约不是优化);
 *   - 箱体:从不复用,每次非空 plan 都销毁重建;
 *   - disabled spec 不进接线;其存活实例销毁;
 *   - globalBypass:跳过全部接线,inputGain 直连 looper/output,保留 kept 实例
 *     (箱体除外——它在 bypass 时同样销毁);
 *   - 保留实例每次执行都回放 spec 参数(值可能已变);
 *   - dispose 先于一切创建与接线。
 */

/** 引擎重建链条所需的快照 */
export interface ChainSpec {
  uid: string;
  def: EffectDefinition;
  enabled: boolean;
  values: Record<string, number>;
  /** false = 箱头之前(前置);true = 箱头之后、箱体之前(FX Loop) */
  post: boolean;
}

/** 箱头快照(null 表示不启用箱头) */
export interface AmpSpec {
  def: EffectDefinition;
  enabled: boolean;
  values: Record<string, number>;
  /**
   * 配置版本键:def 与 key 都相同且启用时,重建复用存活实例(不重新加载模型)。
   * 模型/配置变化时必须换 key(如 `${ampId}:${namVersion}`)。
   */
  key?: string;
}

/** 一次图谱编译的输入:Rig 结构快照 */
export interface GraphSpec {
  chain: ChainSpec[];
  amp: AmpSpec | null;
  cab: AmpSpec | null;
  globalBypass: boolean;
}

/** 存活的单块实例及其身份(post 记录建图时的分区,用于结构比对) */
export interface PedalEntry {
  def: EffectDefinition;
  post: boolean;
  inst: EffectInstance;
}

/**
 * planGraph 的另一输入:上一次建图的存活产物。
 * globalBypass 为 null 表示从未建图(首次强制出非空 plan,
 * 否则 inputGain → looper/output 的直通接线永远不会发生)。
 */
export interface GraphPrevState {
  instances: Map<string, PedalEntry>;
  ampInstance: EffectInstance | null;
  ampInstanceDef: EffectDefinition | null;
  ampInstanceKey: string | null;
  cabInstance: EffectInstance | null;
  cabInstanceDef: EffectDefinition | null;
  globalBypass: boolean | null;
}

/** 单块决策:inst 为 null = execute 新建;非 null = 复用存活实例 */
export interface PedalPlan {
  uid: string;
  def: EffectDefinition;
  post: boolean;
  inst: EffectInstance | null;
  /** 新建与复用都回放的参数值 */
  values: Record<string, number>;
}

/** 箱头决策(语义同 PedalPlan;key 落进 artifacts 供下轮复用比对) */
export interface AmpPlan {
  def: EffectDefinition;
  key: string | null;
  inst: EffectInstance | null;
  values: Record<string, number>;
}

/** 箱体决策:从不复用,故无 inst 字段,永远新建 */
export interface CabPlan {
  def: EffectDefinition;
  values: Record<string, number>;
}

/** 一次图谱编译的全部决策;empty=true 时其余字段无意义,execute 直接 no-op */
export interface GraphPlan {
  empty: boolean;
  globalBypass: boolean;
  /** 要销毁的旧实例,先于一切创建与接线;顺序:单块 → 箱头 → 箱体 */
  dispose: EffectInstance[];
  /** 非 bypass:接线清单(前置段 → 后置段);bypass:保留清单(不接线、不新建、不回放) */
  pedals: PedalPlan[];
  amp: AmpPlan | null;
  cab: CabPlan | null;
}

/** execute 需要的固定主链路节点(引擎持有) */
export interface GraphEnv {
  inputGain: GainNode;
  inputAnalyser: AnalyserNode;
  outputAnalyser: AnalyserNode;
  looperNode: AudioNode | null;
}

/** execute 的产物:engine 整体替换对应字段(不做原地 clear/set) */
export interface GraphArtifacts {
  instances: Map<string, PedalEntry>;
  moduleAnalysers: Map<string, AnalyserNode>;
  ampInstance: EffectInstance | null;
  ampInstanceDef: EffectDefinition | null;
  ampInstanceKey: string | null;
  cabInstance: EffectInstance | null;
  cabInstanceDef: EffectDefinition | null;
  preAmpAnalyser: AnalyserNode | null;
  ampAnalyser: AnalyserNode | null;
  cabAnalyser: AnalyserNode | null;
  globalBypass: boolean;
}

const EMPTY_PLAN: GraphPlan = {
  empty: true,
  globalBypass: false,
  dispose: [],
  pedals: [],
  amp: null,
  cab: null,
};

/** 启用清单按接线顺序排列(前置段 → 后置段);结构判定与接线共用,保证永远一致 */
function orderedEnabled(chain: ChainSpec[]): ChainSpec[] {
  const enabled = chain.filter((s) => s.enabled);
  return [...enabled.filter((s) => !s.post), ...enabled.filter((s) => s.post)];
}

/** 箱头复用判定:def+key 相同且启用 → 复用(避免 NAM 模型重复加载);结构比对与 plan 共用 */
function ampMatchesPrev(amp: AmpSpec | null, prev: GraphPrevState): boolean {
  return (
    prev.ampInstance !== null &&
    amp !== null &&
    amp.enabled &&
    prev.ampInstanceDef === amp.def &&
    prev.ampInstanceKey === (amp.key ?? null)
  );
}

/** 结构比对:spec 与上次建图产物是否一致(仅结构,不含参数值) */
function isStructuralMatch(spec: GraphSpec, prev: GraphPrevState): boolean {
  if (prev.globalBypass === null || prev.globalBypass !== spec.globalBypass) return false;

  // 单块:启用清单按接线顺序(前置段 → 后置段)与存活实例逐位比对(uid+def+post)
  const ordered = orderedEnabled(spec.chain);
  const entries = [...prev.instances.entries()];
  if (ordered.length !== entries.length) return false;
  for (let i = 0; i < ordered.length; i++) {
    const [uid, entry] = entries[i];
    if (ordered[i].uid !== uid || ordered[i].def !== entry.def || ordered[i].post !== entry.post) {
      return false;
    }
  }

  // 箱头:启用状态、def、key 三者一致
  const ampActive = spec.amp !== null && spec.amp.enabled;
  if (ampActive !== (prev.ampInstance !== null)) return false;
  if (ampActive && !ampMatchesPrev(spec.amp, prev)) return false;

  // 箱体:bypass 下恒不存在,不参与比对;否则启用状态与 def 一致
  if (!spec.globalBypass) {
    const cabActive = spec.cab !== null && spec.cab.enabled;
    if (cabActive !== (prev.cabInstance !== null)) return false;
    if (cabActive && prev.cabInstanceDef !== spec.cab!.def) return false;
  }
  return true;
}

/** 纯决策:由 spec 与上次建图产物推出创建/复用/销毁清单(零 WebAudio 依赖) */
export function planGraph(spec: GraphSpec, prev: GraphPrevState): GraphPlan {
  if (isStructuralMatch(spec, prev)) return EMPTY_PLAN;

  // 单块复用:uid+def 相同且启用 → 保留(保住已加载模型与 LFO/延迟状态),其余销毁
  const kept = new Map<string, PedalEntry>();
  const dispose: EffectInstance[] = [];
  for (const [uid, entry] of prev.instances) {
    const match = spec.chain.find((s) => s.uid === uid && s.enabled && s.def === entry.def);
    if (match) {
      kept.set(uid, entry);
    } else {
      dispose.push(entry.inst);
    }
  }

  // 箱头复用:def+key 相同且启用 → 复用(避免 NAM 模型重复加载)
  const ampActive = spec.amp !== null && spec.amp.enabled;
  const ampKey = ampActive ? (spec.amp!.key ?? null) : null;
  const reuseAmp = ampMatchesPrev(spec.amp, prev);
  if (prev.ampInstance && !reuseAmp) dispose.push(prev.ampInstance);
  // 箱体从不复用
  if (prev.cabInstance) dispose.push(prev.cabInstance);

  let pedals: PedalPlan[];
  let amp: AmpPlan | null = null;
  let cab: CabPlan | null = null;
  if (!spec.globalBypass) {
    pedals = orderedEnabled(spec.chain).map((s) => ({
      uid: s.uid,
      def: s.def,
      post: s.post,
      inst: kept.get(s.uid)?.inst ?? null,
      values: s.values,
    }));
    if (ampActive) {
      amp = {
        def: spec.amp!.def,
        key: ampKey,
        inst: reuseAmp ? prev.ampInstance : null,
        values: spec.amp!.values,
      };
    }
    if (spec.cab && spec.cab.enabled) {
      cab = { def: spec.cab.def, values: spec.cab.values };
    }
  } else {
    // bypass:只保留已存活的复用实例(不接线、不新建、不回放),恢复时原样接回
    pedals = [...kept.entries()].map(([uid, entry]) => ({
      uid,
      def: entry.def,
      post: spec.chain.find((s) => s.uid === uid)?.post ?? entry.post,
      inst: entry.inst,
      values: {},
    }));
    if (reuseAmp) {
      amp = {
        def: prev.ampInstanceDef!,
        key: prev.ampInstanceKey,
        inst: prev.ampInstance!,
        values: {},
      };
    }
  }

  return { empty: false, globalBypass: spec.globalBypass, dispose, pedals, amp, cab };
}

/** 电平表抽头:仅测量,不影响音频路径;统一 fftSize=1024 */
function createTap(ctx: AudioContext, from: AudioNode): AnalyserNode {
  const tap = ctx.createAnalyser();
  tap.fftSize = 1024;
  from.connect(tap);
  return tap;
}

/** 回放 spec 参数:新建与复用实例都执行(值可能已变) */
function replayValues(inst: EffectInstance, values: Record<string, number>): void {
  for (const [k, v] of Object.entries(values)) inst.update(k, v);
}

/** 薄执行:按 plan 销毁/创建/接线,返回全部产物;空 plan 返回 null 且不触碰任何状态 */
export function executePlan(
  ctx: AudioContext,
  env: GraphEnv,
  plan: GraphPlan,
): GraphArtifacts | null {
  if (plan.empty) return null;

  // 1. dispose 先于一切创建与接线
  for (const inst of plan.dispose) inst.dispose();

  const artifacts: GraphArtifacts = {
    instances: new Map(),
    moduleAnalysers: new Map(),
    ampInstance: null,
    ampInstanceDef: null,
    ampInstanceKey: null,
    cabInstance: null,
    cabInstanceDef: null,
    preAmpAnalyser: null,
    ampAnalyser: null,
    cabAnalyser: null,
    globalBypass: plan.globalBypass,
  };

  // 2. 复用实例断开旧下游(电平抽头/下一级),稍后按新顺序重接
  for (const p of plan.pedals) p.inst?.output.disconnect();
  plan.amp?.inst?.output.disconnect();

  // 3. 断开 inputGain 全部下游(含 analyser 与旧链),再按新链重连
  env.inputGain.disconnect();
  env.inputGain.connect(env.inputAnalyser);

  let prev: AudioNode = env.inputGain;
  if (!plan.globalBypass) {
    const connectPedal = (p: PedalPlan) => {
      const inst = p.inst ?? p.def.create(ctx);
      replayValues(inst, p.values);
      prev.connect(inst.input);
      prev = inst.output;
      artifacts.moduleAnalysers.set(p.uid, createTap(ctx, inst.output));
      artifacts.instances.set(p.uid, { def: p.def, post: p.post, inst });
    };
    // 前置段(post=false):踏板 → 箱头
    for (const p of plan.pedals) {
      if (!p.post) connectPedal(p);
    }
    // 箱头前抽头:前置链末端(削波检测/背景变色用)
    artifacts.preAmpAnalyser = createTap(ctx, prev);
    // 箱头位于前置效果链之后(踏板 → 箱头的真实路由)
    if (plan.amp) {
      const amp = plan.amp.inst ?? plan.amp.def.create(ctx);
      replayValues(amp, plan.amp.values);
      prev.connect(amp.input);
      prev = amp.output;
      artifacts.ampInstance = amp;
      artifacts.ampInstanceDef = plan.amp.def;
      artifacts.ampInstanceKey = plan.amp.key;
      artifacts.ampAnalyser = createTap(ctx, amp.output);
    }
    // 后置段(post=true):FX Loop,箱头之后、箱体之前
    for (const p of plan.pedals) {
      if (p.post) connectPedal(p);
    }
    // 箱体位于箱头之后、输出之前(关闭即 DI 直通);从不复用,永远新建
    if (plan.cab) {
      const cab = plan.cab.def.create(ctx);
      replayValues(cab, plan.cab.values);
      prev.connect(cab.input);
      prev = cab.output;
      artifacts.cabInstance = cab;
      artifacts.cabInstanceDef = plan.cab.def;
      artifacts.cabAnalyser = createTap(ctx, cab.output);
    }
  } else {
    // bypass:保留复用实例的归属(不接线、不重载,恢复时原样接回)
    for (const p of plan.pedals) {
      if (p.inst) artifacts.instances.set(p.uid, { def: p.def, post: p.post, inst: p.inst });
    }
    if (plan.amp?.inst) {
      artifacts.ampInstance = plan.amp.inst;
      artifacts.ampInstanceDef = plan.amp.def;
      artifacts.ampInstanceKey = plan.amp.key;
    }
  }
  // Looper 是固定输出级的一部分,不随效果链重建;若加载失败则安全直通。
  prev.connect(env.looperNode ?? env.outputAnalyser);
  return artifacts;
}
