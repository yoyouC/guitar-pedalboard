# 0002. rigStore:Rig 状态单一事实源,引擎为被动投影

## 状态

已采纳(2026-08,issue #6)

## 背景

Rig(效果链 + 箱头 + 箱体 + 全局参数)是应用的核心状态,但没有单一事实源:
`src/state/store.ts` 名为 store 却只有纯函数,真正的状态容器是 `App.tsx`
的 32 个 `useState`。由此产生三类摩擦:

- **双写**:每个参数回调都要手动 `setState` + `audioEngine.updateXxx`,
  散在 App 与各组件 props 里;
- **恢复路径分裂**:预设加载(12 步手动 setter 序列)、快照 recall、
  URL hash 还原,三条路径各自记得补写引擎,写法互不相同——
  `recallSnapshot` 甚至漏写,靠结构重建兜底;
- **组件穿透引擎**:`TopBar` 背着 25 个 prop,`AmpPanel` 背着回调束,
  编排逻辑(快照 capture/recall/dirty、预设恢复、URL 同步、MIDI 绑定执行)
  在 god-component 里不可测试。

## 决定

新建 `src/state/rigStore.ts`:模块级 pub-sub store,工厂形态
`createRigStore(engine)`,作为 Rig 状态的单一事实源。零新增依赖。

- **小 interface**(`getState` / `subscribe` + 一组 verb)藏住
  "rig 状态 ⇆ 引擎 ⇆ localStorage" 的全部同步。verb 内部统一
  "改状态 → 同步引擎 → 必要时持久化";结构性 verb(增删/排序/开关/
  前后置/换箱头箱体/bypass)直接调引擎四连
  (`setGlobalBypass → setChain → setAmp → setCab`,各 setter 内部
  rebuildGraph)并自增 `graphVersion`,App 的 `structureKey` memo +
  同步 effect 删除。
- **三条恢复路径合一为 `applyRig`**:预设/快照/分享各自规范化成
  `ApplyRigState`(`rigFromPreset` / `rigFromSnapshot` / `rigFromShare`),
  写引擎的调用序列因此必然一致(测试钉死)。快照路径 `ampModel: null`
  表示绕过型号机制(ampId 为权威,不触碰 NAM 全局态与 namVersion)——
  保持旧 recall 语义。
- **引擎依赖注入**:engine 参数类型收窄为 `Pick<typeof audioEngine, …>`
  的 9 个方法;测试传 stub(断言调用序列),生产传单例
  (`src/state/useRig.ts` 导出 `rigStore = createRigStore(audioEngine)`),
  可并行起多个独立 store。引擎 init 前的 verb 调用保持旧语义
  (引擎层容忍:只记 spec / ctx 守卫),rigStore 不引入 ready 概念。
- **React 绑定**:`useRig(selector)` = `useSyncExternalStore` +
  区块级 selector(返回原始值或状态内稳定引用);组件直接订阅,
  App 降为 shell。URL hash 同步保留为 App 里的 400ms 防抖订阅投影
  (按编码结果比较,非分享字段变化不触发)。
- **边界**:搬入 rigStore = chain、箱头/箱体及其型号簿记、namCustomName、
  namVersion、全局参数、snapshots/activeSlot、presets、graphVersion。
  留在 App = 输入源/设备枚举/engineReady、纯 UI 开关、MIDI Learn 状态
  (midiBindings/learnMode/armedTarget)。`executeMidiBinding` 改为调用
  rigStore verb,MIDI 与 UI 触发走同一代码路径。
- `src/state/store.ts` 保留为纯函数模块(ChainItem/Snapshot 类型、
  预设/快照持久化、presetCodec 包装),被 rigStore 与 share 引用——
  这是最小 diff 选择,不消灭它。

## 后果

- 新增参数类型只改一处:verb 内统一双写,调用方(UI/MIDI/键盘)不再
  直接接触引擎的 rig 面。
- 快照 capture/recall/clear/dirty、预设保存/加载/删除、三条恢复路径的
  一致性都被 `tests/rig-store.test.ts`(node:test + stub engine)钉死;
  这套逻辑离开 React 后可测。
- 有意保持的行为差异(不是 bug):
  - Learn 模式 armed 高亮重扫的依赖从 `chain` 改为 `graphVersion`
    (data-midi-target 只随结构变化,参数拖动不再触发 DOM 重扫);
  - 预设加载不再先对旧箱头实例发冗余的 updateAmpParam(重建会回放
    参数,旧调用本就无效)。
- NAM 模型选择的模块级全局态(namWasm.ts 的 currentSource/currentPack)
  本次不收编,`namVersion` 原样保留在 rigStore 内(另立候选)。
