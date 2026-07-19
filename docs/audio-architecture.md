# 音频后端架构

音频层位于 `src/audio/`,完全独立于 React,可以在任何框架(或无框架)下复用。全部基于原生 Web Audio API,核心是一个单例引擎 + 一套插件式效果器接口。

## 1. AudioEngine(`src/audio/AudioEngine.ts`)

### 1.1 单例与固定主链路

`AudioEngine` 是单例,对外导出 `audioEngine`。它持有唯一的 `AudioContext` 和一条**固定不变的主链路**:

```
[输入源] → inputGain → inputAnalyser(仅测量)
        → [效果链 → 箱头 → 箱体]      ← rebuildGraph() 动态拼装的部分
        → outputAnalyser(仅测量) → masterGain → limiter → ctx.destination
```

- `inputAnalyser` / `outputAnalyser`:`fftSize 2048`,只用于示波器/电平表/流体背景取波形,不影响音频。
- `limiter`:`DynamicsCompressorNode`(threshold `-12dB`、knee `0`、ratio `20:1`、attack `3ms`、release `100ms`),作为输出保护天花板。
- 两个 `AnalyserNode` 暴露为公开字段,UI 组件直接读取。

### 1.2 生命周期

- `init()`:**懒初始化、幂等**。首次选择输入源时才创建 `AudioContext`(满足浏览器自动播放策略),并在此加载噪声门 AudioWorklet、构建一次 `rebuildGraph()`。之后调用只 `resume()`。
- 没有 `destroy()` —— 引擎随页面存活。

### 1.3 输入源(互斥切换)

| 方法 | 来源 | 说明 |
|---|---|---|
| `useMic(deviceId?)` | `getUserMedia` | 显式关闭 `echoCancellation` / `noiseSuppression` / `autoGainControl`,避免浏览器预处理毁掉吉他信号 |
| `useFile(file)` | 音频文件 | `decodeAudioData` 后循环播放 |
| `useTestTone()` | 内置采样 | 加载 `public/samples/guitar-riff.wav`(Karplus-Strong 合成,可用 `scripts/render-guitar-riff.mjs` 重新生成);加载失败自动回退到 `useSynthRiff()`(sawtooth + 低通 + 包络的程序 riff,`setInterval` 触发) |
| `stopInput()` | — | 停止当前源 |

`stopSource()` 负责清理:停 `AudioBufferSourceNode`、关 `MediaStream` 轨道、清 riff 定时器。切换输入源前都会先调它,保证互斥。

### 1.4 rebuildGraph:效果链的"编译器"

引擎不直接感知 React 状态,而是接收三份**快照**(`ChainSpec[]` / `AmpSpec` / `AmpSpec` 箱体),任何结构变化都通过全量替换快照 + `rebuildGraph()` 完成:

```
setChain(specs) / setAmp(spec) / setCab(spec) / setGlobalBypass(b)
        │
        ▼
rebuildGraph():
  1. 对旧实例逐个 dispose()(停 LFO、断开节点),清空模块电平表
  2. inputGain.disconnect() 后重接 inputAnalyser
  3. prev = inputGain;按序遍历 chain 中 enabled 的单块:
       inst = def.create(ctx) → 回放全部参数值 → prev.connect(inst.input) → prev = inst.output
       并给每块输出挂一个 AnalyserNode 抽头(fftSize 1024,供单块迷你电平表)
  4. 若箱头启用:同样 create + 回放参数,接在效果链之后
  5. 若箱体启用:接在箱头之后(关闭即 DI 直通)
  6. prev.connect(outputAnalyser)
  7. globalBypass 时跳过 3~5,输入直连输出
```

要点:

- **每次重建都是全新实例**。这意味着 LFO 相位、延迟线缓冲等会被重置 —— 因此参数连续调整**绝不走这条路**,而是走 `updateParam(uid, key, value)` / `updateAmpParam(key, value)` / `updateCabParam(key, value)`,直接调用存活实例的 `update()`。
- 路由顺序遵循真实设备:**单块 → 箱头 → 箱体(→ 输出)**。
- 每块单块的输出电平抽头通过 `getModuleAnalyser(uid)` 暴露给 UI。

### 1.5 其他输出控制

- `setInputGain(v)` / `setMasterVolume(v)`:`setTargetAtTime` 平滑(τ=20ms)。
- `setOutputDevice(deviceId)`:特性检测 `AudioContext.setSinkId`,不支持返回 `false`。

## 2. 效果器插件接口(`src/audio/effects/types.ts`)

整个音频层围绕三个小接口旋转,**单块、箱头、箱体共用同一套**:

```ts
interface ParamDef {           // 一个可调参数的描述,UI 据此自动渲染旋钮
  key: string;                 // update(key, value) 的寻址键
  label: string;               // UI 显示名
  min: number; max: number; step: number;
  defaultValue: number;
  unit?: string;               // 'ms' / 'Hz' / 'dB' / '%' 等
}

interface EffectInstance {     // 一个已实例化的处理器
  input: GainNode;             // 约定:外部 prev.connect(inst.input)
  output: GainNode;            //        inst.output.connect(next)
  update(key, value): void;    // 参数连续调整,内部必须平滑
  dispose(): void;             // 停 LFO/定时器 + 断开所有内部节点
}

interface EffectDefinition {   // "目录项":描述 + 工厂
  id: string;                  // 唯一 id,约定与文件名一致
  name: string;                // 显示名
  color: string;               // 单块外壳颜色(--pedal-color)
  params: ParamDef[];
  create(ctx: AudioContext): EffectInstance;
}
```

### 实现约定(所有内置效果器都遵守)

1. `input`/`output` 都是 `GainNode`,内部节点在两者之间自由连接。
2. 所有参数变化用 `setTargetAtTime(value, ctx.currentTime, SMOOTH)` 平滑(SMOOTH 通常 0.02~0.03s),**禁止直接赋值 `.value`**(爆音)。
3. `create()` 里把默认值写到节点上(与 `params` 的 `defaultValue` 一致),引擎重建时会再回放一遍当前值。
4. `dispose()` 必须停掉 `OscillatorNode`(LFO)并 `disconnect()` 全部内部节点 —— `rebuildGraph` 依赖它防止节点泄漏。
5. `WaveShaperNode` 一律开 `oversample: '4x'`(或 `'2x'`)抑制混叠。
6. 削波曲线用 1024 点 `Float32Array` 查表(`tanh` 软削波 / 硬削波 / 不对称削波等)。

### 注册表(`src/audio/effects/index.ts`)

`EFFECT_REGISTRY` 是一个按吉他信号链常见顺序排列的 `EffectDefinition[]`;`getEffectDef(id)` 按 id 查找。UI 的"添加效果器"菜单、单块渲染全部从注册表驱动。箱头和箱体有各自独立的注册表 `AMP_REGISTRY`(`amps.ts`)、`CAB_REGISTRY`(`cabs.ts`),接口相同。

## 3. 17 款单块速查

| id | 名称 | 参数 | 实现要点 |
|---|---|---|---|
| `noiseGate` | Noise Gate | threshold/attack/release | **AudioWorklet**(见 §6):整块 RMS 比较阈值得目标增益,attack/release 逐样本平滑;worklet 未加载时兜底直通 |
| `compressor` | Compressor | threshold/ratio/attack/release/makeup | `DynamicsCompressorNode` + makeup 增益,knee 固定 12dB |
| `klon` | Transparent OD | gain/treble/level | Klon 风格:锗管软削波曲线 + **干声 40% 恒定并联**(clean blend)+ 3kHz treble 搁架(±10dB) |
| `overdrive` | Overdrive | drive/tone/level | tanh 软削波,drive 同时映射激励增益(1~50)与曲线硬度 k(1~50) |
| `ts808` | TS808 Drive | drive/tone/level | 按 ElectroSmash 电路分析:720Hz 高通(频率选择性削波)→ 反馈二极管软削波 → 51pF 边角软化(7k LP)→ 730Hz 中频隆起(+3dB)→ 723Hz 无源低通 → 3.2kHz Tone 高架 |
| `distortion` | Distortion | gain/tone/level | 硬削波(阈值 0.4 截平) |
| `rat` | RAT Dist | drive/filter/level | 1.5kHz 削波前高通(紧实低频)→ 硅管对地硬削波 → 16kHz 边角软化 → 5.3kHz 模拟 LM308 慢摆率 → Filter 反向扫频低通(32k→475Hz) |
| `fuzz` | Fuzz | fuzz/tone/level | 大 k 值 tanh 逼近方波的对称硬削波 |
| `autowah` | Auto-Wah | sens/freq/reso/mix | 包络跟随:全波整流(WaveShaper `y=|x|`)→ 8Hz 低通取包络 → 包络量控制带通滤波器频偏(最大 4kHz 摆动) |
| `eq` | 3-Band EQ | low/mid/high | lowshelf 100Hz + peaking 1kHz(Q=1)+ highshelf 4kHz,±15dB |
| `chorus` | Chorus | rate/depth/mix | 20ms 基准延迟 + LFO 调制 delayTime(±5ms);**干湿等功率交叉淡化**(dry=cos θ, wet=sin θ) |
| `flanger` | Flanger | rate/depth/feedback/mix | 短延迟 + 反馈环 + LFO 扫 delayTime |
| `phaser` | Phaser | rate/depth | 4 级 allpass(400/800/1600/3200Hz,Q=0.5),LFO 统一扫各级频率(±1500Hz) |
| `tremolo` | Tremolo | rate/depth | LFO → modGain.gain 幅度调制;depth 同时反向调基准增益保持平均电平 |
| `delay` | Delay | time/feedback/mix | `DelayNode`(最大 2s)+ 反馈环 + 干/湿并联 |
| `reverb` | Reverb | time/decay/mix | `ConvolverNode` + 程序生成 IR(见 §6);time/decay 变化时重建 IR |
| `volume` | Volume & Pan | level/pan | 增益 + `StereoPannerNode` |

每款的细节直接读对应文件即可 —— 单文件 60~130 行,头部注释都写了电路参考和链路。

## 4. 箱头(`src/audio/amps.ts`)

4 款箱头复用效果器接口,分为两类实现:

### 4.1 配置驱动(3 款:clean / recto / chime)

`AMP_MODELS` 用一份配置描述音色特征,通用工厂 `createAmp(ctx, cfg)` 拼装固定拓扑:

```
input → 高通(preHpHz,切低频保持紧实)
      → preGain(1 ~ preGainMax,GAIN 旋钮驱动)
      → WaveShaper tanh 前级削波(preClipK,4x oversample)
      → voicing(peaking,特征峰/凹陷)
      → 音色栈: lowshelf 120Hz(BASS) → peaking 700Hz(MID)
              → highshelf 3.2kHz(TREBLE) → highshelf 5kHz(PRESENCE,0~+8dB)
      → WaveShaper 后级饱和(powerClipK)
      → masterGain → output
```

配置项:`preGainMax` / `preClipK` / `preHpHz` / `voicingFreq` / `voicingGainDb` / `powerClipK` / 六个旋钮默认值。BASS/MID/TREBLE 旋钮按 `(v-50)/50 × 12dB` 映射。

### 4.2 定制电路(crunch,British Crunch)

`customCreate: createCrunchAmp` 指向独立函数,做 Plexi/JCM800 级电路建模(详见 `amps.ts` 头部大注释):

- 120Hz 早切低频 → V1B 增益级软削 → Miller 高频滚降(6.5k LP)+ bright cap 高频补偿(2.5k 高架 +3dB)
- **cold clipper**:固定激励 4× + 不对称削波曲线(负半周 tanh 4.5 硬削、正半周 tanh 1.1 软削),产生以二次谐波为主的失真
- 暖偏置级 → 第二级 Miller 滚降 → 阴极跟随器
- 音色栈带 500Hz 特征凹陷(-3.5dB)
- EL34 后级 → 输出变压器带宽限制(80Hz HP + 6.5kHz LP)

### 4.3 参数与注册

6 个固定旋钮:`gain/bass/mid/treble/presence/master`(0~100)。`makeAmpDef()` 包装成 `EffectDefinition` 进入 `AMP_REGISTRY`,`getAmpDef(id)` 查找。新增箱头:优先在 `AMP_MODELS` 加配置;不够用时加 `customCreate`。

## 5. 箱体(`src/audio/cabs.ts`)

纯频响整形(无卷积 IR),拓扑固定:

```
input → 高通(hpHz) → 低频共振峰(lowBump) → 临场峰(peak,可调 Q)
      → 低通 ×2(24dB/oct,lpHz) → output(LEVEL)
```

4 款配置:`open1x12`(开背,低频少)、`blue2x12`(Celestion Blue)、`gb4x12`(Greenback,默认)、`v304x12`(Vintage 30,攻击性上中频)。唯一参数 `level`(映射 0~1.2 增益)。关闭箱体即 DI 直通。

## 6. 两个特殊模块

### AudioWorklet 噪声门(`src/audio/noiseGateWorklet.ts`)

- 处理器源码写成字符串,`Blob` + `URL.createObjectURL` 内联加载,**免构建配置**。
- `loadNoiseGate(ctx)` 幂等,在 `AudioEngine.init()` 中 `await`;失败仅警告,`noiseGate.ts` 里构造 `AudioWorkletNode` 抛错时兜底为直通。
- 算法:整块 RMS 与阈值比较得 0/1 目标增益,再按 attack/release 系数逐样本一阶平滑(避免开关爆音与声像抖动)。

### 混响 IR(`src/audio/impulseResponse.ts`)

`makeImpulseResponse(ctx, seconds, decay)`:双声道指数衰减白噪声(`(random*2-1) × (1-i/len)^decay`)。Reverb 的 time/decay 参数变化时重新生成。

## 7. 如何新增一款效果器

以新增 "Vibe" 为例:

1. 新建 `src/audio/effects/vibe.ts`,导出 `vibeEffect: EffectDefinition`:
   - `id: 'vibe'`(与文件名一致)、`name`、`color`;
   - `params`:描述每个旋钮(key/min/max/step/defaultValue/unit);
   - `create(ctx)`:创建 `input`/`output` GainNode 和内部节点,连好内部图,把默认值写到节点上,返回 `{ input, output, update, dispose }`。`update` 里用 `setTargetAtTime`;`dispose` 里停 LFO + 全部 `disconnect()`。
2. 在 `src/audio/effects/index.ts` 的 `EFFECT_REGISTRY` 合适位置加一行。

完成。UI 会自动出现:"添加效果器"下拉多出该选项,`PedalCard` 按 `params` 渲染旋钮并套用 `skin-vibe` CSS 类(想定制外壳配色/字体就在 `index.css` 加 `.skin-vibe { … }`,不加也有默认皮肤)。预设系统按 `effectId` 存取,无需改动。

新增箱头/箱体同理:改 `AMP_MODELS` + `AMP_REGISTRY`(或 `CAB_MODELS` + `CAB_REGISTRY`),面板自动出现新选项卡。

## 8. 已知限制与注意事项

- **重建即重置**:任何结构变化(增删单块、排序、toggle、换箱头/箱体、全局 bypass)都会销毁并重建全部实例 —— LFO 相位归零、delay/reverb 尾音中断。这是有意的简单设计,不是 bug。
- **预设只覆盖单块链**:`store.ts` 的 `Preset` 不含箱头/箱体/输入增益等全局设置。
- **单声道化**:麦克风输入是单声道源;链内 `StereoPannerNode`/立体声 IR 可以制造立体声,但多数单块内部是单声道拓扑。
- **电平抽头在 bypass 时消失**:单块 disabled 时不实例化,`getModuleAnalyser(uid)` 返回 `null`,迷你电平表同时隐藏(UI 已处理)。
- 采样率相关常量(如 IR 长度)都在 `create()` 时按 `ctx.sampleRate` 计算,无硬编码 44.1kHz。
