# 0005. 图谱编译拆分为 functional core(planGraph)+ imperative shell(executePlan)

## 状态

已采纳(2026-08,issue #9)

## 背景

`AudioEngine.rebuildGraph` 是音频子系统最微妙、bug 最多的逻辑:单块
uid+def 复用、箱头 def+key 复用(NAM 重载极贵,这是契约不是优化)、
箱体从不复用、dispose 必须先于接线、bypass 期间保留实例但不接线、
保留实例每次重建回放 spec 参数。但它长在 AudioEngine 单例内部
(私有构造 + 硬编码 `new AudioContext()`),零测试覆盖——任何复用
语义的回归只能靠浏览器手动听音发现。

同时 rigStore 的 `syncStructure` 固定四连写引擎(setGlobalBypass →
setChain → setAmp → setCab),每次结构 verb 触发四次全量重建,其中
约三次是纯冗余(spec 相对上次建图产物没有任何结构变化)。

## 决定

- 图谱编译拆为两层,新模块 `src/audio/graphBuilder.ts`:
  - **planGraph(spec, prevState) → GraphPlan**:纯函数,零 WebAudio
    依赖。只做决策:创建/复用/销毁清单 + 保留实例的回放参数值,
    不含连线描述,不调用 `def.create`(NAM 只比对 def+key)。
    spec 无结构变化(含仅参数值变化)返回空 plan。
  - **executePlan(ctx, env, plan) → GraphArtifacts**:薄执行。按固定
    线性规则(inputGain → 前置链 → preAmp tap → 箱头 → FX Loop 后置链
    → 箱体 → looper/output)创建节点与接线,含每 spec 的 analyser
    tap 与 preAmp/amp/cab 三个 analyser。空 plan 返回 null,不触碰
    任何状态。NAM 的 fetch/模型缓存等模块级副作用只允许在这一层
    被触达(经 `def.create`)。
- AudioEngine 遗留职责:持有 ctx 与 env 节点(inputGain、三个固定
  analyser、looperNode);四个 setter 改为"更新 spec → planGraph →
  executePlan → 整体替换 artifacts 字段"(不再原地 clear/set);
  updateParam/updateAmpParam/updateCabParam 继续从 artifacts 读实例。
  私有构造与硬编码 context 不动。
- 复用契约按现状钉死,不借重构改语义:uid+def 复用单块、def+key
  复用箱头、箱体从不复用、disabled spec 跳过、globalBypass 跳过全部
  接线并保留 kept 实例、保留实例回放参数、dispose 先于接线。
- prevState 相比 issue 草图补两个字段,都是结构判定的必要条件:
  `cabInstanceDef`(箱体 def 无法从实例判定,否则换箱体检不出结构
  变化)与 `globalBypass`(否则 bypass 翻转检不出;bypass 稳态下箱体
  恒不存在,不参与比对)。`globalBypass=null` 表示从未建图,首次强制
  非空 plan——否则空 rig 下 inputGain → looper/output 的直通接线永远
  不会发生。
- 测试:`tests/graph-plan.test.ts` 钉纯决策(假 def 的 create 直接
  throw,证明 plan 不触达 WebAudio);`tests/graph-execute.test.ts` 经
  stub-audio-context 钉接线 smoke(只用注册表普通 def,NAM 不进单测)。

## 后果

- 图谱决策首次可在 `node:test` 下覆盖:复用/销毁/回放/bypass 语义
  各有针对性断言,回归无需浏览器。
- 冗余消解自然达成:syncStructure 四连写不变(rigStore 地盘不动),
  结构未变的写产生空 plan → execute no-op,不再每次 verb 重建四次图
  (尤其箱体不再被无意义地销毁重建四次,听感等价)。
- 语义 pinning(有意,听感零变化):"结构不变 → 空 plan"意味着仅参数
  值变化的 spec 不再触发重建回放;参数调整本就走 updateParam 系列
  (setTargetAtTime 平滑),applyRig 三条恢复路径都会重新生成 uid,
  必然构成结构变化,因此无实际行为差异。
- 代价:结构判定依赖 prevState 完整记录产物身份(def/key/post/
  bypass),字段清单与 AudioEngine 私有状态一一对应,新增产物种类时
  两边要同步(编译期有类型检查兜底)。
