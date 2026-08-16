# 0004. 单一动作词汇表 RigAction:翻译层 / dispatch 分层

## 状态

已采纳(2026-08,架构评审候选 2,issue #8)

## 背景

同一组可控目标(单块开关、快照、bypass、Looper、Master 音量、箱头参数、
摇杆踏板)在 MIDI 层有两套平行词汇表:`MidiAction`(默认映射用,值在
resolve 阶段已归一化)与 `MidiTarget`(MIDI Learn 用,不带值,执行时才
映射)。执行逻辑随之裂成两个 switch(`useMidi` 的 action→回调分发与 App
的 `executeMidiBinding`),App 的键盘 handler 是第三个平行分发器;CC 上升
沿检测与 0..127 值映射有两份实现,其中 App 侧那份完全不可测。

## 决定

- **单一词汇表 RigAction**(`src/midi/midiMapping.ts`,由 MidiAction 改名
  扩充):一次"要执行什么"的意图,一律携带映射后的语义值。新增
  `set-pedal-param` / `set-pedal-treadle` 两个变体吸收 Learn 侧目标;
  `set-expression`(序数语义,"第 N 块摇杆踏板")与链索引语义并存。
- **翻译层**(`src/midi/rigAction.ts`,纯函数):Learn 绑定命中时
  `translateBinding(target, msg, prevValue, chain) → RigAction|null`,
  收编 CC 上升沿检测、`ccToRange` 值映射、`getEffectDef` 参数范围查表、
  Note Off 忽略;`resolveKeyAction` 平移键盘映射表(1..9/QWER/空格)。
  per-binding 沿检测状态由 `createBindingTranslator()` 工厂持有(生产用
  薄包装)。默认映射 `resolveMidiAction` 签名、行为、24 个测试用例不变。
- **dispatch**(`src/midi/rigDispatcher.ts`):`createRigDispatcher(deps)`
  工厂(deps = rigStore verb 面 + Looper 控制),无状态纯执行,action 到达
  即调 verb;链索引/序数 → uid 的解析在本层完成(链状态从 rigStore 读)。
  Looper 走 `looperPrimaryCommand` 共享守卫。生产端在 App 模块级创建一次。
- **删除**:App 的 `executeMidiBinding`、`midiEdgeRef`、useMidi 的
  action→回调 switch、键盘 handler 的直接执行、`isToggleTarget` 死导出。
- **MidiTarget 收窄为纯地址类型**("绑的是哪个控件"),注释写清与
  RigAction 的分工:`MidiBinding` 持久化形状不变(用户绑定零迁移)。

## 后果

- 新增一个可 MIDI 控制的目标只改一处(词汇表 + 翻译 + dispatch 同层相邻),
  默认映射 / Learn / 键盘自动同时获得它,行为不可能分叉。
- 沿检测与值映射首次进入 node:test 覆盖(翻译层纯函数);dispatch 用
  `createRigStore(stubEngine)` 直接断言 verb 调用(tests/rig-action.test.ts,
  27 例)。
- App 不再承担 MIDI 执行职责,也不持有消息流处理状态。
- 已知边界:MidiTarget 的链上位置索引在拖拽排序后错位(候选 6 范围,
  本决策不处理也不恶化);Learn 的 DOM 扫描与 UI 流程不动。
