# 音频时延基准

本文件定义 issue #18 的可复现基准。代码库不会伪造开发机或虚拟声卡结果；参考硬件测量完成后，将同一份诊断 JSON 与本表一起归档。

## 固定矩阵

| 维度 | 一级环境 | 冒烟 / best-effort |
|---|---|---|
| OS | macOS、Windows 11 | 其他桌面系统 |
| 浏览器 | 当前 Chrome Stable | Edge；Safari/Firefox 能力展示 |
| 音频设备 | 固定记录的 48kHz USB 声卡 + 有线耳机 | 内建设备、蓝牙 |
| 档位 | 实时演奏、平衡、稳定播放 | — |

每次记录 commit、CPU/内存、OS/浏览器主版本、声卡与设备、请求/实际音频参数、冷启动时间、输出估算五点窗口、Rig 链路时延、可用时的 playbackStats、30 分钟稳定性和电气往返校准。设备名称只进入用户明确选择的本地导出。

## 三层场景

1. 默认 Rig：出厂配置，冷启动一次，稳态 5 分钟，连续运行 30 分钟。
2. 压力 Rig：NAM Amp、两个 NAM Pedal、多个 WDF Pedal与动态背景；再启用“降低视觉负载”重复一轮，音频档位和 Rig 不变。
3. 单模块：Whammy、共享 4x WDF FIR、当前 Full NAM；记录链路 sample、稳态 CPU/内存和音频回归标识。

## 判定

- 实时档输出估算目标 ≤10ms；默认 Rig 非音乐性链路 ≤3ms；USB 电气往返目标 ≤15ms，冲刺 ≤10ms。
- 参考 Rig 连续 30 分钟无可感知断音；浏览器提供 playbackStats 时 underrun 为 0。
- “延迟改善”需要同一矩阵至少改善 1ms 或 10%。否则只能在 CPU headroom 或 underrun 显著改善时归类为稳定性优化。
- 主线程长任务、FPS 或 DevTools CPU 不能证明音频中断或音频延迟改善；缺失字段保持“不可用”。

## 当前自动化证据

- 三档 Context/capture 请求、持久化和损坏值回退。
- runtime 准备—激活—提交/回滚事务。
- Rig 活动路径、globalBypass、Whammy 设计时延与 WDF FIR 处理时延计算。
- WDF canonical DSP golden；共享 4x FIR 单位脉冲峰值与声明值误差不超过 1 sample。
- 回环相关算法的已知延迟、静音、削波、多峰与环境失效测试。

物理矩阵结果必须在真实参考声卡上执行，不能由 CI、离线单元测试或主观听感代填。
