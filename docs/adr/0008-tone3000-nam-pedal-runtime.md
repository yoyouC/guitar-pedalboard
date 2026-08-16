# 0008. TONE3000 NAM 单块：外部模型身份、逐目标运行态与 OAuth 意图

## 状态

已采纳（2026-08，issue #17；扩展 ADR-0007）

## 背景

ADR-0007 只把 TONE3000 NAM 接入箱头位。效果链若把动态 tone id 塞进
`effectId`，静态效果目录、Rig 序列化和音频图复用都会失去稳定身份；若只保存
`tone_id`，托管 Select 返回的具体 `model_id` 又会在恢复时丢失。一个 Rig 还可
同时包含多个外部单块，单个箱头通知无法表达各自的加载、失败与修复状态。

## 决定

- `tone3000Nam` 是唯一稳定的效果类型。`ChainItem.modelRef` 保存
  `tone3000:{toneId}`，可选 `modelId` 保存托管选择返回的精确模型变体；同样的
  精确身份也适用于 TONE3000 箱头。
- Preset 写 v3，Share 写 v2；读取继续接受 Preset v2、Share v1、无版本 Snapshot
  和历史箱头引用。所有外部 id 在 `presetCodec` 规范化后才可进入音频图。
- 单块图复用身份为 `uid + def + model identity + runtime generation`。模型引用或
  精确变体变化只重建该单块；失败后的重试成功通过 transient generation 重建
  直通实例，不把运行状态写进 Rig。
- `Tone3000RigIntegration` 是新增、事务式换型、恢复、逐目标状态、错误分类、批量
  重试和下载调度的公共边界。目标按 `amp` 或 `pedal:{uid}` 标识；下载共享容量为
  8 的模型文本 LRU，并经并发度 2 的队列调度，失败不缓存且不取消其他目标。
  `namWasm` provider 边界也对所有实际下载执行相同的全局上限，因此音频图直接装载
  不会绕过资源预算。每个目标以请求代次拒绝迟到结果覆盖新选择。
- 新增先校验 `gear=pedal` 与 `format=nam`，然后在前置区末尾提交 ChainItem。
  下载中或失败时单块直通且引用保留。换型在 metadata 与模型预取都成功后才提交，
  因而保留 uid、顺序、前后置、开关、LEVEL 与旧声音。
- 首版 TONE3000 单块仅暴露外部 LEVEL；固定 snapshot 不虚构 DRIVE、TONE 或
  conditioning 通道。相同模型可有多个独立 uid 和 AudioWorklet voice。
- 新选择由共享 modal 完成：默认 A2，次入口为省略 architecture 的 A1/Custom；
  pedal Select/Trending 使用 `gear=pedal`，不展示无法按 gear 过滤的 Latest。
  箱头新选择使用 `gear=amp`；历史引用恢复时不追溯拒绝。
- popup 被阻挡时同时暂存 canonical return Rig 与显式意图（箱头、新增单块、替换
  指定 uid）。回调先恢复 Rig 再应用 tone/model；Share 恢复重建 uid 时，仅在
  原链位置和原 `modelRef` 同时匹配时安全重映射，否则产生可见错误且不改动
  其他 ChainItem。
- 登出清除令牌和可重新下载的模型文本缓存，不停止已经驻留在 AudioWorklet 中的
  模型。之后的新增、恢复或重新加载必须重新认证。
- 箱头和单块共享账户与归属展示：图片、gear、format、标题、作者头像/用户名、
  license、canonical link 和 Powered by TONE3000；已登录账号由 `/api/v1/user` 显示。

## 后果

- 外部依赖不可用只改变 runtime projection，不改变可分享的用户意图；多个失败可
  独立修复，一次登录可批量重试当前 Rig 的全部 TONE3000 目标。
- `effectId` 继续是静态目录身份，`modelRef/modelId` 成为以后接入其他外部模型来源
  可复用的扩展缝。
- 下载完成与实际发声实例之间需要显式 reload generation；它是运行时实现细节，
  不属于 Snapshot、Preset 或 Share。
- 仍不解决 NAM 采样率、A2 响度归一化、Full/Lite 选择和 CPU 预算等问题。
