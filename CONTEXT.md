# CONTEXT

本文件的用途:固定项目的领域词汇(ubiquitous language)。讨论架构、写 issue/ADR、命名模块时,优先使用这里的词。代码标识符用英文,行文用中文。

## 信号链(从吉他到耳朵)

- **Rig** —— 一份完整可复现的配置:效果链 + 箱头 + 箱体 + 全局参数(inputGain、masterVolume、globalBypass)。序列化、快照、预设、分享的对象都是 Rig。
- **效果链(Chain)** —— 有序的单块列表,每项(`ChainItem`)有稳定身份 `uid`、效果 `effectId`、开关 `enabled`、参数 `values`、前后置位 `post`;模型型单块另有外部 `modelRef/modelId`，不把动态模型身份塞进 `effectId`。
- **单块(Pedal)** —— 效果链上的一级效果器(过载、延迟、混响、哇音……)。注册于 `src/audio/effects/`。
- **箱头(Amp)** —— 效果链之后的放大器级,有自己的开关与参数;同一箱头可能有多个**模型(model)**(如 NAM 扫档包的档位)。
- **箱体(Cab)** —— 箱头之后的箱体模拟级。
- **FX Loop / 后置位(post)** —— 单块可放在箱头前(默认)或箱头后/箱体前(`post: true`)。
- **NAM** —— Neural Amp Modeler,经 WASM 运行的神经网络箱头/单块模型;有**扫档包(sweep pack)**(一个模型按增益分档)。
- **WDF** —— Wave Digital Filter,白盒电路建模的另一条 DSP 路线(与 NAM 并列)。

## 状态与持久化

- **rigStore** —— Rig 状态的单一事实源(模块级 pub-sub store,见 ADR-0002)。引擎是它的被动投影;快照/预设/URL 三条恢复路径都经 `applyRig` 收口。
- **快照(Snapshot)** —— 板载 A/B/C/D 四个槽位的 Rig 即时存取(= Rig − 全局参数),含 ampCategoryId+ampModelKey(走型号机制);踩钉长按清空。槽位有 **dirty**(已修改)状态。序列化上它是 canonical Rig 表示的派生(ADR-0006);旧形状(ampId-only)宽容解析,回退"保持当前型号"行为。
- **预设(Preset)** —— 用户命名保存的 Rig,localStorage 持久化,可导入导出。
- **分享(Share)** —— Rig 的 URL hash 编码(`#p=`),也是出厂默认配置的加载路径。

## 音频基建

- **AudioEngine** —— 音频图的所有者:AudioContext、主链路、worklet 预载、输入源、录音、Looper 宿主、图谱编译(rebuildGraph)。
- **Worklet** —— AudioWorklet 处理器;经 `createWorkletLoader` 按 AudioContext 幂等注册(ADR-0001)。
- **图谱编译(rebuildGraph)** —— 由 Rig 快照重建/复用音频节点图的过程;实例复用语义:uid+def 复用单块,def+key 复用箱头,箱体从不复用。内部分两层(ADR-0005):**plan**(纯函数决策:创建/复用/销毁清单,无 WebAudio 依赖)与 **execute**(薄执行:节点创建与连线,NAM 的 fetch 等副作用隔离在此层)。
- **DSP 核(`*.dsp.js`)** —— WDF 算法的唯一 canonical 源(纯 JS + JSDoc,与 worklet 同目录)。两个消费对象:worklet 侧经 `?raw` 取源码字符串拼装 Blob,eval/测试侧正常 import 执行。验证的代码 = 发声的代码(ADR-0003)。
- **音频档位(Audio Profile)** —— 当前设备的运行偏好：实时演奏、平衡或稳定播放。它只影响浏览器音频请求，不属于 Rig，也不改变 DSP 音质。
- **输出估算(Output Estimate)** —— 浏览器报告的 `baseLatency + outputLatency` 输出侧估算；不包含输入捕获、Rig 链路或完整物理设备往返。
- **链路时延(Rig Latency)** —— 当前活动 Pedal、Amp、Cab 在直接监听路径中声明并合成的 sample/ms 计算值；处理时延与音乐性的设计时延分开记录。
- **往返时延(Round-trip Latency)** —— 仅指低电平电气回环校准得到的输入到输出实测值；设备或音频环境变化即失效。
- **音频中断(Underrun)** —— 仅指浏览器 `playbackStats` 等音频能力明确报告的中断。主线程长任务、掉帧与压力测试只是独立代理指标。
- **DSP 质量(DSP Quality)** —— 独立于音频档位的音色/资源选择；只有具有真实能力且完成性能与音频验证的模块才可开放。

## 演奏辅助

- **Looper** —— 单轨循环录音(初录/叠录/撤销/清空),挂在全 Rig 输出之后。
- **MIDI 映射(MIDI mapping)** —— 出厂固定的控制器→动作映射(K25、motion_midi 总线)。
- **MIDI Learn** —— 用户自定义的 MIDI 绑定:进入 Learn 模式、点击控件武装(armed)目标、扭/踩控制器完成绑定。
- **RigAction(动作词汇表)** —— 一次"要执行什么"的意图(切单块、召回快照、设箱头参数……),携带映射后的语义值。所有触发源(MIDI 默认映射、MIDI Learn、键盘)统一翻译成 RigAction,经同一 dispatch 执行。与 **MidiTarget**(Learn 绑定的持久化**地址**,回答"绑的是哪个控件")是两个概念:地址 + 原始值 → 翻译层 → RigAction。
- **表情踏板 / 摇杆(Treadle)** —— CC 连续控制源,驱动哇音 position、Whammy 移调等连续参数。
- **TONE3000** —— 外部 NAM 模型分享平台(tone3000.com),经官方 API v1(OAuth 2.0 + PKCE)接入;托管 Select 可为 Amp 或 Pedal 限定 gear/architecture，模型按用户身份在请求时下载(ADR-0007、ADR-0008)。
- **tone_id / model_id** —— `tone_id` 是 tone pack 的稳定数字 id，编码为外部引用 `tone3000:{toneId}`；`model_id` 是其中一次托管选择的精确 NAM 变体。Preset、Snapshot、Share 保存引用和可用的精确变体，恢复失败只改变逐目标运行态，不丢用户意图。
