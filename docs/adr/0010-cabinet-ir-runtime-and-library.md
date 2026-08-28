# ADR-0010: Cabinet IR Runtime 与本地 IR Library

- 状态：Accepted
- 日期：2026-08-28
- 关联：Issue #19

## Context

原四个 Cab 是串联 Biquad 的近似频响，不能加载用户自己的箱体 IR。直接把 File、Blob
或 AudioBuffer 放进 rigStore 会破坏 Preset/Snapshot/Share 的可移植 canonical
表示；直接改活动 Convolver 的 buffer 或重建整张图又容易产生爆音并重载无关的
Pedal/Amp。

## Decision

- Rig 只持有 `CabIrRef`：内置 id 或自定义原始文件 SHA-256。Preset 升 v4、Share
  升 v3；二进制永不进入 JSON/URL。
- WAV 导入按“读取/容器校验/hash/decode/PCM 校验/共同裁剪/Runtime prepare/IDB
  persist/同步 activate/canonical commit”执行。任一步失败都不提交 Rig；generation
  阻止迟到结果覆盖新选择。
- Custom IR 在导入时离线计算与内置资产同口径的 70 Hz–10 kHz、1,024 点
  pink-power 加权传递增益，并用固定资产增益对齐 `+1.8 dB` 目标。自动增益限制在
  `[-24,+12] dB`，且校准后单位脉冲峰值不得超过 1；它不改写 PCM，也不是实时 AGC。
  校准值随本地记录保存，旧 IndexedDB 记录在首次解码时确定性补算。Custom IR 的新建
  LEVEL 默认值为 `-2 dB`；已有 Rig 中用户保存的 LEVEL 不迁移、不覆盖。
- 自定义库保留原始 Blob 与展示元数据，16 条/64MB；Rig/Preset/Snapshot 引用 pinned，
  其余 LRU。删除被引用项会被拒绝。
- Cab Runtime 的 input/output 身份稳定，内部使用两个 `normalize=false` Convolver lane，
  约 30ms 等功率交叉淡化。每个 lane 独立应用 manifest 资产校准，再由稳定 output 应用
  用户 LEVEL；两者不会互相覆盖。Graph Plan 按 def+key 复用 Cab，global bypass 只断开并保留。
- Audio Profile 候选 context 必须先解码活动 IR 才能提交。自定义 hash 缺失时保留原引用，
  运行时明确回退 `gb4x12`，匹配 hash 的重新导入可修复。
- 四个内置 IR 必须在 `public/irs/manifest.json` 完成来源、许可、署名、SHA-256、产品映射
  与校准并获用户批准。项目方确认持有四个所选 Tone Factor 文件的单独直接分发授权后，
  生产文件完成门禁，IR UI 启用，旧 Biquad Cab DSP 移除；WAV 以 hash 指纹命名并使用
  immutable 静态缓存。
- Preset/Snapshot 的整 Rig 恢复同样走 IR prepare 事务：解码失败不提交任何 Rig 字段；
  自定义 hash 缺失时提交原目标引用，但同步激活 `gb4x12` 运行时回退。

## Consequences

自定义文件只在当前浏览器可用，分享给另一设备时可能显示“IR 缺失”但不会篡改目标音色。
每个 AudioContext 拥有自己的 lazy AudioBuffer cache；内存只预热活动内置项。旧 DSP
的响应参数已记录在研究基线中，代码与部署版本仍可通过 Git 回滚。同一 WAV 走内置或
Custom 身份时，在各自默认 LEVEL 下的目标输出差不超过 `0.5 dB`；厂商文件本身的电平
差异不再直接泄漏到两条产品路径之间。
