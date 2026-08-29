# ADR-0011: 固定箱头前十段均衡级

- 状态：Accepted
- 日期：2026-08-29
- 关联：Issue #20

## Context

用户需要在进入箱头前统一修整整条前置 Pedal 链的频响。把图示均衡建成普通可拖动
Pedal 会让位置语义不稳定，也会出现多个实例；复用 Amp 的 Bass/Mid/Treble 又会混淆
“箱头音色栈”和“箱头前整形”两个不同概念。均衡 bypass、推子和 Level 是演奏中频繁
改变的实时参数，不应触发整张音频图重建。

## Decision

- canonical 信号顺序固定为 `Input → pre Pedals → Pre-Amp EQ → Amp → post Pedals → Cab → Output`。
  Pre-Amp EQ 是 Rig 中唯一的专用级，不进入可拖动 Chain，也不允许创建第二个实例。
- 使用 31.25、62.5、125、250、500、1k、2k、4k、8k、16k Hz 十个 peaking Biquad，
  Q 为 `√2`，每段和输出 Level 均为 `-12..+12 dB`、`0.5 dB` 步进。高频中心在低采样率
  设备上限制为 Nyquist 以下。该级不声明额外处理时延。
- Runtime 的 input/output 身份在 AudioContext 生命周期内稳定。参数与独立 bypass 通过
  `20 ms` Web Audio 参数平滑实时投影；bypass 将十段与 Level 平滑回到单位增益，但仍记住
  且允许编辑目标值。它不调用 `rebuildGraph`。全局 bypass 仍绕过整个 Rig。
- `preAmpEq` 成为 Rig、Preset、Snapshot 与 Share 的 canonical 字段。Preset 升 v5、Share
  升 v4；频段以稳定名称保存而非数组下标。旧版本或字段缺失时迁移为“关闭、全平、Level 0”，
  解析时非有限值回退且所有 dB 值钳制到范围内。
- 面板固定在效果器板下、箱头面板上。折叠状态只属于本机 UI 偏好并存入 localStorage，
  不属于 Rig；bypass、Reset 与折叠按钮始终留在标题栏。MIDI Learn 可绑定 bypass、各频段与 Level。

## Consequences

用户在任何 Rig 恢复路径中都得到相同的箱头前频响，旧链接和旧预设不会意外改变声音。
频繁调节或旁路不会重建 Pedal/Amp/Cab 节点，因此不会引入额外加载或切图爆音。该固定级
增加十个常驻 Biquad，但旁路时参数为单位增益；若以后要改变频段数量或身份，必须显式迁移
canonical 数据，不能依赖 UI 顺序。
