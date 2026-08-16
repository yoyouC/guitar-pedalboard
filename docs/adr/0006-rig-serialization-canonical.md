# 0006. Rig 序列化单一 canonical 表示:Snapshot/Share 派生,legacy 快照宽容解析

## 状态

已采纳(2026-08,issue #10,架构评审候选 5)

## 背景

同一个 Rig 曾有三种序列化形状:`RigPresetState`(预设,嵌套、带
globals 与 customName)、`ShareState`(URL 分享,平面、无 globals)、
`Snapshot`(板载快照,平面、以 ampId 为权威),外加 rigStore 的恢复
入口 `ApplyRigState`(第四种"统一形状")。normalize/clamp 知识散在
三处且语义不一(share 用 `Number()` 强转,presetCodec 用
`typeof === 'number'`);快照路径完全不校验,坏槽位裸奔进
`getEffectDef` 才 throw。实际 bug:快照只存 ampId,丢 modelKey——
记得 NAM 箱头却记不住是哪个模型。

## 决定

- `RigPresetState` 为唯一 canonical 序列化表示,由 presetCodec 拥有;
  normalize/clamp 单点(`normalizeRig` 及其子函数)供所有路径共用。
- **Snapshot = Rig − globals、Share = Rig − globals − customName**,
  均为派生。share 的短字段 base64url 编码层保留(只管压缩),decode
  后改走 catalog normalize;`ApplyRigState` 收敛为 canonical + uid 化
  chain,`rigFrom*` 三个规范化器退化为薄派生。
- **快照携带 `ampCategoryId` + `ampModelKey` 成对**,recall 走型号机制
  (修复 modelKey 丢失)。amp 为 union:型号机制分支 |
  `legacyAmpId` 分支。
- **legacy 宽容**:旧持久化快照(扁平 ampId-only)照常加载,recall
  保持旧行为(绕过型号机制、不动 NAM 全局态);无版本号、无迁移写回,
  重新 capture 自然写成新形状。
- **`loadSnapshots` 逐槽位校验**(有意行为变化):坏槽位 → null,
  不再 throw;槽位数截断/补齐到 SNAPSHOT_COUNT。
- **clamp 语义从严**:统一为 presetCodec 的 `typeof === 'number'`;
  share 编码格式零变化,野外已分享 URL 与 `DEFAULT_RIG_ENCODED`
  继续可用(由既有测试 pin)。
- `store.ts` 收敛为纯 persistence 模块(catalog + ChainItem +
  localStorage IO + v1→v2 预设迁移写回);类型别名
  (Preset/FullRigState/RestoredFullRigState)删除,消费方改指
  presetCodec;默认常量(型号/箱体/globals)收进 catalog 单点,
  rigStore 初始状态由 catalog 推导。

## 后果

- 加一个 rig 字段只改 canonical 与派生规则,不再三处分别决定。
- 两处有意行为变化(随 PR 标注):① 快照 recall 开始走型号机制;
  ② 坏快照槽位从 throw 变为静默置空。另有两处微小行为对齐:
  share 缺省箱体段产出默认参数值(原为空 values);share 不再容忍
  字符串数字(合法编码器从不产生)。
- 已知限制(留待评审候选 8):modelKey `nam-wasm:custom` 的快照/
  分享恢复的是"自定义模型"这个引用,实际模型源仍是 namWasm 模块级
  全局态;自定义 NAM 模型不随快照/分享切换。
- 别名层删除后类型来源单点化;无组件 import 相关类型,爆炸半径
  限于 state 层四个文件。
