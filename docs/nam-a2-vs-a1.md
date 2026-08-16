# NAM A2(Slimmable WaveNet)vs A1:格式、运行时与宿主适配审计

调研日期:2026-08-16。结论全部来自一手来源:NeuralAmpModelerCore 源码
(sdatkinson/NeuralAmpModelerCore,main 分支,core 0.5.5)、tone3000 官方 A2 指南、
tone-3000/neural-amp-modeler-wasm 官方 WASM 引擎源码,以及本仓库的绑定与构建脚本。
每条结论附来源 URL。

**TL;DR:`nam::get_dsp(json)` 对 A2 透明,我们的绑定不做任何修改即可正确运行
A2-Full(默认即全尺寸)。真正需要跟进的只有一项待验证的响度归一化缺口
(container 型 A2 文件顶层可能无 `metadata.loudness`),其余均为 should/optional。**

## 1. A2 模型格式:.nam JSON 与 A1 的差异

A2 没有一个叫 "A2" 的 architecture 魔数。实际线上文件是两种形态:

### 形态一:`SlimmableContainer`(tone3000 A2 下载的主形态)

顶层 `architecture: "SlimmableContainer"`,`config.submodels[]` 是若干个**完整的
NAM 模型 spec**(各自带 `architecture`/`config`/`weights`),每个挂一个
`max_value` 阈值;文件版本 `0.7.0`。核心按 `SetSlimmableSize(val)` 与
`max_value` 比较来选激活哪个子模型,**默认激活最后一个(全尺寸)**:

- 源码:[NAM/container.cpp](https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/NAM/container.cpp)
  (`_get_index_for_slimmable_size`、构造函数里 `_active_index = _submodels.size() - 1`)
- 实例:[example_models/A2.nam](https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/example_models/A2.nam)
  (顶层 `version: "0.7.0"`,`submodels[0].max_value: 0.5`,子模型为 `WaveNet`)
- 指南佐证:"An A2 download is a single NAM model that can be run as either
  A2-Full or A2-Lite" —— [tone3000 A2 指南](https://tone3000.com/guides/nam-a2-the-complete-guide)

这正对应 A2-Full / A2-Lite:同一个文件里的大小子模型,不是两个文件。

### 形态二:`WaveNet` + `slimmable` 字段(SlimmableWavenet)

`architecture` 仍是 `"WaveNet"`,但 layer array 上多了
`slimmable: {method: "slice_channels_uniform", kwargs: {allowed_channels: [...]}}`。
WaveNet 的配置解析器在 `create_config` 里嗅探该字段,命中则构造
`SlimmableWavenet`(运行时按通道数切片权重子集):

- 源码:[NAM/wavenet/model.cpp](https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/NAM/wavenet/model.cpp)
  (`config_is_slimmable_wavenet`、`create_config` 分发)、
  [NAM/wavenet/slimmable.cpp](https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/NAM/wavenet/slimmable.cpp)
- 实例:[example_models/slimmable_wavenet.nam](https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/example_models/slimmable_wavenet.nam)
- 我们 wasm 里的字符串 `SlimmableWavenet`、`No config parser registered for
  architecture:` 即来自这条 registry 路径(`ConfigParserHelper`
  静态注册,registry 缺 parser 时抛该错误)。

### WaveNet config 本身的新字段(A2 世代,A1 解析不认识的)

A2 世代的 WaveNet config 相对 A1 新增/改变(均已在核心 parser 中支持):
逐层 `kernel_sizes` 数组(取代单一 `kernel_size`)、`head` 对象
(`{out_channels, kernel_size, bias}`,兼容旧 `head_size`/`head_bias` —— 我们 wasm
里的错误字符串 "expected 'head' object with out_channels, kernel_size, and bias,
or legacy 'head_size' and 'head_bias'" 即此双格式校验)、`bottleneck`、逐层
`activation` 数组、`gating_mode`、`layer1x1`/`head1x1`、`groups_input`、8 个 FiLM
配置、`secondary_activation`、以及可选的 `condition_dsp` 子模型(模型内嵌一个小
网络,从同一路输入生成条件信号,**对宿主透明**,见第 3 节)。

- 来源:model.cpp `parse_config_json`;
  [example_models/wavenet_a2_max.nam](https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/example_models/wavenet_a2_max.nam)
  ("test case to contain all of the new features that are being considered for A2",
  `version: "0.6.0"`)
- 文件版本规则:[docs/nam_file_version.rst](https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/docs/nam_file_version.rst)

### 文件版本与核心版本

- A2 文件版本为 `0.7.0`(A2.nam、slimmable_wavenet.nam 实例);核心声明
  `LATEST_FULLY_SUPPORTED_NAM_FILE_VERSION = "0.7.0"`、`EARLIEST = "0.5.0"`
  —— [NAM/get_dsp.h](https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/NAM/get_dsp.h)。
  我们 wasm 里的 `0.5.0`/`0.7.0` 字符串正是这两个常量。
- 最低核心版本:官方支持矩阵写 core 0.4.1 起完整支持 0.7.0 文件
  ([nam_file_version.rst](https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/docs/nam_file_version.rst)),
  但仓库[没有 v0.4.1 tag](https://github.com/sdatkinson/NeuralAmpModelerCore/tags);
  实测 `v0.4.0` tag 下 `NAM/wavenet/slimmable.cpp` 与 `NAM/container.cpp` 均不存在
  (404),`v0.5.0` 起存在。**实操最低版本 = core v0.5.0。**
- 我们 wasm 二进制里同时存在 `SlimmableWavenet` 与 `SlimmableContainer` 符号,
  且构建脚本 GLOB 了 `NAM/*.cpp` + `NAM/wavenet/*.cpp`
  ([wasm/build-nam-wasm.sh](../wasm/build-nam-wasm.sh))→ 两个 parser 都在,版本满足。

## 2. 运行时要求:get_dsp 是否透明

**透明,无需宿主 opt-in。** `get_dsp(json)` → `populate_dsp_data` →
`ConfigParserRegistry::parse(architecture, config, expected_sample_rate)` 统一分发,
`WaveNet`/`SlimmableContainer` 的 parser 都是核心内静态注册的;宿主不需要任何新
API 调用即可让 A2 正确发声:

- [NAM/get_dsp.cpp](https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/NAM/get_dsp.cpp)
  (`get_dsp_with_current_prewarm_default` 走统一 registry 路径)
- 默认尺寸:container 默认激活全尺寸子模型;SlimmableWavenet 构造时按全通道建模
  (`_rebuild_model(full_channels)`,
  [slimmable.cpp](https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/NAM/wavenet/slimmable.cpp))。
  **即:不调 `SetSlimmableSize`,跑的就是 A2-Full,最高质量。**
- `process()` 语义不变(`NAM_SAMPLE**` 通道指针数组);A2 container 是
  `DSP(1,1)`,`NumInputChannels() == 1`(container.cpp 构造函数)。
- 延迟:核心 DSP 基类没有任何 latency API
  ([NAM/dsp.h](https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/NAM/dsp.h)),
  WaveNet 为因果卷积,零额外延迟,**无需延迟补偿**。
- 官方 wasm 引擎的加载路径与我们等价:`get_dsp(parse(json))` → 可选
  `SetSlimmableSize` → `Reset(sampleRate, maxFrames)`(core ≥ 0.5.4 起 Reset 默认
  触发预热)——
  [wasm/nam-engine.cpp](https://github.com/tone-3000/neural-amp-modeler-wasm/blob/main/wasm/nam-engine.cpp)
  `nam_loadModel`。我们绑定直接调 `prewarm()`
  ([wasm/nam-dsp-binding.cpp](../wasm/nam-dsp-binding.cpp)),
  在"默认全尺寸"前提下效果等同(见第 6 节的细微差别)。

## 3. 条件化(conditioning)

- A1 条件化模型(NAMKnobs 类):`condition_size > 1` → `NumInputChannels() > 1`,
  ch0 音频 + ch1.. 旋钮恒定值。我们绑定的 `setConditioning` 路径对此不变;A2 没有
  改变这条机制。
- A2 线上模型(tone3000 导出)是**快照模型**:container 为 1 进 1 出,子模型
  `condition_size: 1`(A2.nam 实例),**不需要、也不接受旋钮条件通道**。
  A2-Full/Lite 的选择走 `SetSlimmableSize`,不是条件输入。
- `condition_dsp` 是核心的新能力(模型内嵌小网络从同一输入生成条件信号),其输入
  通道数在构造期校验必须与外层 WaveNet 一致(model.cpp:605 附近),对宿主完全透明,
  不要求宿主提供额外通道。
- 宿主从不发条件时的行为:我们绑定对缺失通道送全零缓冲(= 旋钮 0 位),
  这是 A1 既有行为,A2 快照模型根本走不到这条分支(`nCh == 1`)。

## 4. 采样率

- **NAM Core 从不重采样。** `expected_sample_rate` 只是从 .nam 顶层
  `sample_rate` 字段读出并记录(`get_sample_rate_from_nam_file`,get_dsp.cpp),
  `DSP::Reset` 仅存储外部采样率并预热
  ([NAM/dsp.cpp](https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/NAM/dsp.cpp));
  模型在宿主给定的任何采样率下直接跑,采样率不符 = 音高/音色偏移,核心不管。
- wasm 字符串 `") doesn't match WaveNet expected sample rate ("` 出自
  [model.cpp](https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/NAM/wavenet/model.cpp)
  构造期校验:**内嵌 condition_dsp 与外层 WaveNet 的期望采样率互相一致性检查**,
  与宿主 AudioContext 采样率无关。A2 没有引入新的采样率严格性。
- A2 文件与 A1 一样声明 `"sample_rate": 48000`(A2.nam / slimmable_wavenet.nam
  实例),即训练与期望运行率仍是 48k。
- 宿主侧义务因此不变但要自己承担:官方 wasm 引擎专门导出
  `nam_getExpectedSampleRate` 供 JS 查询(nam-engine.cpp);我们绑定未导出,
  且 app 用 `new AudioContext()` 不锁采样率
  ([src/audio/AudioEngine.ts:113](../src/audio/AudioEngine.ts))。在 44.1k/96k
  设备上 NAM(A1 与 A2 同样)会跑在非期望采样率上 —— **既有风险,非 A2 特有**。

## 5. CPU / 性能与 slimmable

以下数字均来自 [tone3000 A2 指南](https://tone3000.com/guides/nam-a2-the-complete-guide)
(2026 年 3 月实测):

- A2-Full 比 A1-Standard **快约 30–40%** 且准确度更高;Apple M 系 MacBook 可同时
  跑 64 路 A2-Full、约 200 路 A2-Lite。
- A2-Lite 在 ARM Cortex-M7 600MHz(约 $3 的芯片)上占 50% CPU,是 A2 能上量产
  嵌入式硬件的原因。
- A2 感受野比 A1 长约 50%(能建模 sag/压缩等时间相关行为),并显著减少了 A1
  小 WaveNet 的类混叠与 10kHz 金属振铃伪影。
- **slimmable = 运行时可选宽度。** 核心接口
  [NAM/slimmable.h](https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/NAM/slimmable.h)
  (`SlimmableModel::SetSlimmableSize(0..1)` + `GetSlimmableSizeBreakpoints()`);
  宿主 `dynamic_cast<nam::SlimmableModel*>(model.get())` 探测后调用即可,切换是
  staged 发布(非 RT 安全、RT 线程无感切换,slimmable.cpp `_stage_rebuild_model`)。
- 官方 wasm 引擎完整导出了这套能力:`nam_isSlimmable` / `nam_setSlimmableSize` /
  `nam_getSlimmableBreakpoint(Count)`,JS 侧 `slimSize` 加载选项与 `setSlimSize`
  运行时消息([nam-engine.cpp](https://github.com/tone-3000/neural-amp-modeler-wasm/blob/main/wasm/nam-engine.cpp)、
  [ui/src/engine/NamEngine.ts](https://github.com/tone-3000/neural-amp-modeler-wasm/blob/main/ui/src/engine/NamEngine.ts))。
  **我们绑定未导出 —— 功能缺失但非正确性问题(默认 A2-Full)。**
- 另外两个官方有、我们没有的性能项(均不影响正确性):
  - `nam::activations::Activation::enable_fast_tanh()`(官方在实例创建时调用一次;
    主要加速 tanh 类 A1 模型);
  - `NAM_ENABLE_A2_FAST` 编译宏走 A2 形状专用快速内核(model.cpp `create_config`
    内 `#if defined(NAM_ENABLE_A2_FAST)`)。注意**官方 wasm 构建也没开它**
    ([wasm/CMakeLists.txt](https://github.com/tone-3000/neural-amp-modeler-wasm/blob/main/wasm/CMakeLists.txt)
    只有 `NAM_SAMPLE_FLOAT` + `NAM_USE_INLINE_GEMM` + `-Os -msimd128`,与我们
    `-O3 -msimd128 -DNAM_SAMPLE_FLOAT -DNAM_USE_INLINE_GEMM` 对齐),属可选项。

## 6. 与官方 wasm 引擎逐项对比(我们的绑定缺什么)

对照 [tone-3000 官方 nam-engine.cpp](https://github.com/tone-3000/neural-amp-modeler-wasm/blob/main/wasm/nam-engine.cpp)
与 [wasm/nam-dsp-binding.cpp](../wasm/nam-dsp-binding.cpp):

| 项 | 官方 | 我们 | 判定 |
|---|---|---|---|
| 加载 `get_dsp(json)` | 同 | 同 | 一致,A2 透明 |
| 预热 | `Reset(sr, maxFrames)`(core ≥0.5.4 Reset 默认预热) | `prewarm()` 直调 | 默认全尺寸下等价;但不 Reset 意味着 `_current_sample_rate/_current_buffer_size` 未设置,将来若支持 slim,重建的子模型会退回 expected SR 且不 Reset(核心有回退逻辑,仍正确) |
| 10Hz DC blocker | 有 | 有(同公式) | 一致 |
| 响度归一化(-18 dB 目标、平滑) | wasm 内做 | JS 侧做(-18LUFS,钳 [-12,+36]dB,[namWasm.ts:313](../src/audio/namWasm.ts)) | 算法一致,**但见下方缺口** |
| Slimmable 导出 | 全套 | 无 | optional |
| 期望采样率查询 | `nam_getExpectedSampleRate` | 无 | should |
| fast tanh | 开 | 未开 | optional(CPU) |
| 多实例表 | 有 | 单全局实例 | 目前够用 |
| 错误回传 | `nam_getLastError` | 仅返回码 | optional(可观测性) |

**响度归一化缺口(本审计唯一发现的潜在正确性问题):** 我们的归一化读的是
**.nam 顶层** `metadata.loudness`;而 `SlimmableContainer` 形态下 loudness 记录在
**子模型**的 metadata 里,顶层可以整个没有 `metadata` —— 核心仓库的
[A2.nam 实例](https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/example_models/A2.nam)
正是如此(顶层只有 `version/architecture/config`,loudness -24.04 在子模型内)。
此时 `parseMetadata(json).loudness` 为 `null`,归一化静默跳过,A2 模型的输出电平
会与官方播放器(-18 dB 归一化)不一致。**需要用真实 tone3000 A2 下载文件验证
顶层是否有 `metadata.loudness`;若没有,应取全尺寸(最后一个)子模型的 loudness。**

## 7. 需要适配吗(verdict)

**Must(不改就不能算"正确运行 A2"):**

1. **验证并修复 A2 响度归一化**(第 6 节):用真实 tone3000 A2 文件确认顶层
   `metadata.loudness` 是否存在;缺失时从 `config.submodels` 最后一个(全尺寸)
   子模型的 `metadata.loudness` 取值。这是目前唯一可能导致"A2 能响但不正确"
   (电平偏差)的点。除此之外,音色/条件/采样率/延迟在默认路径上均正确。

**Should(正确性打底 / 与官方对齐):**

2. 加载后把 `prewarm()` 换成 `Reset(sampleRate, maxFrames)`(等价预热 + 记录
   采样率与缓冲尺寸),为将来 slim 切换与核心回退逻辑打底,与官方
   `nam_loadModel` 对齐。
3. 采样率策略:读出 .nam 顶层 `sample_rate`(或导出 `GetExpectedSampleRate`),
   在非 48k 设备上警告或强制 48k。这是 A1 就有的既有缺口,A2 同样受影响。
4. 绑定导出 `getExpectedSampleRate`(一行包装),配合上一条。

**Optional(功能与性能增强):**

5. 导出 `SetSlimmableSize` / `GetSlimmableSizeBreakpoints` / `isSlimmable`,
   支持 A2-Lite 低 CPU 模式(弱设备或同跑多路 NAM 时收益大)。
6. `enable_fast_tanh()`(CPU,主要利 A1)。
7. `NAM_ENABLE_A2_FAST`(官方也未开,开了再 benchmark 验证)。
8. `nam_getLastError` 式错误字符串回传,改善加载失败排查。

## 来源清单

- tone3000 A2 官方指南:<https://tone3000.com/guides/nam-a2-the-complete-guide>
- NAM Core 源码(main):
  - <https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/NAM/get_dsp.cpp>
  - <https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/NAM/get_dsp.h>
  - <https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/NAM/wavenet/model.cpp>
  - <https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/NAM/wavenet/slimmable.cpp>
  - <https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/NAM/slimmable.h>
  - <https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/NAM/container.cpp>
  - <https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/NAM/dsp.cpp>
  - <https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/NAM/dsp.h>
  - <https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/docs/nam_file_version.rst>
  - 示例模型:[A2.nam](https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/example_models/A2.nam)、
    [slimmable_wavenet.nam](https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/example_models/slimmable_wavenet.nam)、
    [wavenet_a2_max.nam](https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/example_models/wavenet_a2_max.nam)
  - tags:<https://github.com/sdatkinson/NeuralAmpModelerCore/tags>
- tone-3000 官方 WASM 引擎:
  - <https://github.com/tone-3000/neural-amp-modeler-wasm/blob/main/wasm/nam-engine.cpp>
  - <https://github.com/tone-3000/neural-amp-modeler-wasm/blob/main/wasm/CMakeLists.txt>
  - <https://github.com/tone-3000/neural-amp-modeler-wasm/blob/main/ui/src/engine/NamEngine.ts>
- 本仓库:[wasm/nam-dsp-binding.cpp](../wasm/nam-dsp-binding.cpp)、
  [wasm/build-nam-wasm.sh](../wasm/build-nam-wasm.sh)、
  [src/audio/namWasm.ts](../src/audio/namWasm.ts)、
  [src/audio/AudioEngine.ts](../src/audio/AudioEngine.ts)
