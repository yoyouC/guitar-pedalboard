# ADR-0028: 默认 DSP 箱体与 Custom IR 混合目录

- 状态：Accepted
- 日期：2026-08-30
- 关联：Issue #19、ADR-0010

## Context

四个 Tone Factor IR 完成接入、客观校准和实际吉他回放后，所有箱头下的默认声音都比
原 Biquad 箱体更暗。浏览器中的卷积输出与 IR、固定资产增益及用户 LEVEL 的数学结果一致，
因此问题来自默认 IR 的频响与仅匹配宽带能量的校准目标，而不是 Convolver Runtime。

产品决定恢复 `1x12 Open`、`2x12 Blue`、`4x12 Greenback`、`4x12 V30` 原有的
Biquad DSP 音色，只为用户自己的 WAV 保留卷积能力。

## Decision

- 四个原有 ID、名称、LEVEL 默认值及 Biquad 参数恢复为原实现。
- `customIr` 是唯一的 Convolver Runtime。点击 `Custom IR` 标签直接打开 WAV 文件选择器；
  不显示箱体下方的导入按钮、搜索、Library 列表或内置 IR 元数据。
- 自定义 WAV 的校验、裁剪、自动电平校准、IndexedDB 持久化、hash 引用、
  Preset/Snapshot/Share 恢复和 Custom IR 之间的 30ms 交叉淡化继续使用 ADR-0010 的实现。
- 从 DSP 切入 Custom IR 时先准备并 stage AudioBuffer，再由同一次同步提交把 Cab 图谱切换
  到 Convolver Runtime；切回默认箱体则重建为对应 DSP definition。
- 自定义 IR 缺失时保留 canonical hash，声音回退到原 `gb4x12` DSP，不加载内置卷积资产。
- 四个未采用的 Tone Factor WAV、manifest、attribution、静态缓存和发布门禁从生产仓库移除；
  选型研究文档保留为决策历史。

## Consequences

默认用户听到与 IR 功能上线前一致的四种箱体声音。Custom IR 仍是本机私有资产；取消文件
选择不会改变 Rig。隐藏 Library 管理 UI 后，已有自定义 IR 仍可由引用它的 Preset、Snapshot
或 Share 恢复，但不再提供独立浏览和删除界面。
