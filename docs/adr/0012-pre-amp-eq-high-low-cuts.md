# ADR-0012: 箱头前均衡增加独立高低切

- 状态：Accepted
- 日期：2026-08-30
- 扩展：ADR-0011

## Context

ADR-0011 建立了效果链前置 Pedal 与箱头之间唯一、固定、可实时调节的十段图示均衡级。
实际演奏还需要在进入非线性箱头前清理低频轰鸣、抑制高频毛边，并允许更明显的频谱塑形。
把截止滤波器放进普通 Pedal、箱头或箱体都会改变既有位置与保存语义；把十段改成参数均衡器则会
破坏 ADR-0011 中稳定的频段身份。

高通和低通 Biquad 没有“gain 回到 0 dB 即单位响应”的旁路能力。仅把截止频率推向 DC 或
Nyquist 只能得到近似中性响应，也无法保证旧 Rig 原声不变；硬切音频连接又可能产生爆音。

## Decision

- 箱头前均衡内部顺序固定为 `Low Cut (HPF) → 10-band Graphic EQ → High Cut (LPF) → Level`。
  外部 input/output 身份及 `Input → pre Pedals → Pre-Amp EQ → Amp` 路由不变，不进入图谱 plan。
- 低切与高切各使用一个 12 dB/oct Biquad，Q 为 `1/√2`（Butterworth，无截止点共振）。低切
  canonical 范围为 `20..500 Hz`、默认 `80 Hz`；高切范围为 `1..20 kHz`、默认 `12 kHz`。
  canonical 值量化为整数 Hz，UI 与 MIDI 使用对数映射。高切仅在 DSP 投影时按
  `sampleRate * 0.45` 限制实际频率，Rig 仍保存跨设备稳定的名义频率。
- 两个切频均有自己的 `{ enabled, frequencyHz }` 状态。关闭时保留并允许编辑频率；总 EQ
  bypass 也保留所有子开关与目标值，编辑任何子参数都不会自动打开开关。
- 每个截止滤波器使用并联 dry/filter-wet 路径。独立开关或总 bypass 在 `20 ms` 内把 dry/wet
  增益线性淡变到精确的 `1/0` 或 `0/1` 结束点；截止频率沿用 `20 ms` AudioParam 平滑。
  十段增益与 Level 延续 ADR-0011 的实时投影。所有操作都不调用 `rebuildGraph`，该级仍声明
  零额外 sample latency。
- Reset 保留总 EQ 开关，但关闭两个切频、恢复 `80 Hz / 12 kHz`，并将十段与 Level 归零。
- 面板顺序与 DSP 一致，切频使用独立竖推子和开关；窄屏维持横向滚动。MIDI Learn 可分别绑定
  两个开关与两个截止频率，CC 截止频率按对数映射。
- `preAmpEq` canonical 状态增加嵌套的 `lowCut` 与 `highCut`。Preset 升为 v6、Share 升为 v5；
  Snapshot、dirty 与三种 Rig 恢复路径包含完整状态。旧 Preset、Share 或缺字段数据统一迁移为
  “两个切频关闭、80 Hz / 12 kHz”，因此保持旧声音。

## Consequences

用户可在失真箱头前独立清理低频与高频，并通过预设、快照、分享和 MIDI 完整复现。旁路稳定态
是真正的干声，而不是极端 cutoff 的近似响应；代价是每个切频增加一个常驻 Biquad、三个 Gain
节点以及短暂切换期间的干湿叠加。十段频率、Q 和稳定序列化身份不变；可调斜率、Q/共振、
箱头后或全局切频以及频谱显示不属于本决策。
