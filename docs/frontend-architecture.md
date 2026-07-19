# 前端架构

前端是**无路由、无状态库**的单页应用:`main.tsx` → `App.tsx`,全部状态集中在 `App`,子组件基本是无状态的"受控展示 + 回调上报"。样式集中在唯一的 `src/index.css`。

## 1. 状态模型(`src/App.tsx`)

`App` 是唯一持有状态的组件,`useState` 状态树分为五组:

| 状态 | 类型 | 说明 |
|---|---|---|
| `chain` | `ChainItem[]` | 效果链,元素:`{ uid, effectId, enabled, values }`(`src/state/store.ts`)。`uid` 用 `crypto.randomUUID()` 生成,是 React key 与引擎寻址的双重身份 |
| `presets` | `Preset[]` | 链条预设,镜像 localStorage(`guitar-pedalboard-presets`) |
| `ampId/ampEnabled/ampValues` | — | 箱头选择与参数(默认 `crunch` 开) |
| `cabId/cabEnabled/cabValues` | — | 箱体选择与参数(默认 `gb4x12` 开) |
| `inputType, engineReady, inputGain, masterVolume, globalBypass` | — | 输入源(`'mic'/'file'/'test'/null`)、引擎就绪标志、电平、全局 bypass |
| `micDevices/outputDevices/micId/outputId` | — | 设备枚举(`enumerateDevices` + `devicechange` 监听) |

`state/store.ts` 是纯函数模块(不进 React):`createChainItem(def)` 按 `ParamDef.defaultValue` 生成新单块;预设序列化/反序列化(`chainToPreset` / `presetToChain`,**不存 uid**,加载时重新生成,缺失参数回落默认值以兼容旧预设)。

## 2. 核心机制:UI ↔ 引擎的双通道同步

这是前端最重要的一段逻辑(`App.tsx` 顶部),务必理解后再改:

```ts
// 结构指纹:只包含影响音频图拓扑的字段
const structureKey = useMemo(
  () => chain.map(i => `${i.uid}:${i.effectId}:${i.enabled}`).join('|')
      + `|bypass:${globalBypass}|amp:${ampId}:${ampEnabled}|cab:${cabId}:${cabEnabled}`,
  [chain, globalBypass, ampId, ampEnabled, cabId, cabEnabled],
);

useEffect(() => {
  audioEngine.setGlobalBypass(...); audioEngine.setChain(...);
  audioEngine.setAmp(...); audioEngine.setCab(...);   // 每个 setter 内部 rebuildGraph()
}, [structureKey]);   // 故意只依赖 structureKey
```

- **通道 A(结构变化,重建图)**:增删单块、拖拽排序、toggle 单块/箱头/箱体、全局 bypass。`structureKey` 变化 → effect 重跑 → 引擎全量重建。注意 `values` 不在指纹里。
- **通道 B(参数变化,不重建)**:拧旋钮。事件处理里**同时**做两件事 —— `setState` 更新 React 状态(为了受控 UI 和预设保存)+ 直接调 `audioEngine.updateParam(uid, key, value)` 平滑改音频参数。此路径不触发 effect、不重建图,因此没有爆音。

```
用户拖动 Knob → onParam(uid,key,v)
                 ├─► setChain(...)               // React 受控状态
                 └─► audioEngine.updateParam(...) // 音频图,绕过 React 渲染
```

同理 `inputGain` / `masterVolume` / 箱头箱体参数都是"setState + 直调引擎"成对出现。**新增交互时遵循同一模式**:影响拓扑的改 `structureKey` 覆盖的状态,连续参数走直调。

## 3. 组件清单(`src/components/`)

| 组件 | 职责 | 关键点 |
|---|---|---|
| `TopBar` | 输入源切换、输入设备/输出设备选择、GAIN/MASTER 滑杆、IN/OUT 电平表、全局 Bypass | 三组 `console-group`;输出设备选择由 `'setSinkId' in AudioContext.prototype` 特性检测 |
| `PresetBar` | 预设保存/加载/删除 | 纯受控,逻辑全在 App |
| `ChainView` | 横向 pedalboard,**HTML5 拖拽排序** | 本地 `dragIndex/overIndex` 两个 state 管理拖拽态,`onDrop` 回调 `onReorder(from, to)`;单块间渲染 `patch-cable` 视觉连接线 |
| `PedalCard` | 单个拟物单块:外壳/螺丝/铭牌/LED/脚踏开关/旋钮排 + 迷你电平表 | 旋钮由 `def.params` **自动渲染**;CSS 类 `skin-${def.id}` + CSS 变量 `--pedal-color`;内嵌 `MiniMeter`(canvas,RMS×1.8,绿→橙→红),仅 enabled 时显示 |
| `Knob` | 拟物旋转旋钮 | 垂直拖动(150px 走满量程)、滚轮微调(Shift ×10)、双击回默认、方向键;`role="slider"` + ARIA;`-135°~135°` 指针 + 11 刻度点 |
| `AddEffectMenu` | 链尾"添加效果器"下拉 | 选项直接来自 `EFFECT_REGISTRY`,加新效果器自动出现 |
| `AmpPanel` | 箱头选项卡 + 拟物箱头(品牌牌/宝石灯/旋钮排/电源杆) | 选项来自 `AMP_REGISTRY`;旋钮同样由 `def.params` 驱动 |
| `CabPanel` | 箱体选项卡 + 箱体外观(网罩/铭牌/LEVEL/CAB-DI 开关) | 选项来自 `CAB_REGISTRY` |
| `Oscilloscope` | 双踪示波器:左半 IN 右半 OUT,实时波形 | 读 `inputAnalyser`/`outputAnalyser` 的时域数据,canvas + rAF |
| `LevelMeter` | RMS 电平表(dB 刻度,-60~0dB 映射,绿→黄→红渐变) | canvas + rAF,只在 analyser 非空时挂载循环 |
| `FluidBackground` | 全屏 WebGL 流体背景 | 见 §4 |

渲染顺序(App JSX):`FluidBackground`(绝对定位垫底)→ 标题 → `TopBar` → `PresetBar` → `ChainView` → `AmpPanel` → `CabPanel` → `Oscilloscope` → 页脚信号流说明。

### 可视化组件的共同点

- 都从 `audioEngine.inputAnalyser / outputAnalyser / getModuleAnalyser(uid)` 拿 `AnalyserNode`,**只读**,不进音频路径。
- 引擎未初始化时 analyser 为 `null`,组件静默(`engineReady` 控制传入)。
- 动画统一 `requestAnimationFrame` 循环 + 卸载时 `cancelAnimationFrame`。

## 4. FluidBackground(WebGL)

`src/components/FluidBackground.tsx`,全屏背景,也是"输出信号健康度"的环境指示:

- 片元 shader:双重 domain-warp 的 fbm 噪声生成流体纹理,暗绿(干净)↔ 橙红(削波)两套配色插值。
- 每帧从 `outputAnalyser` 读时域数据算两个 uniform:
  - `u_amp`:RMS × 3 截断到 0~1,只影响整体明暗;
  - `u_clip`:削波检测 = `rms / p99峰值` 比值(清音 ≈0.4、失真 ≈0.65~0.75、方波 =1),映射 `(ratio-0.55)/0.15` 到 0~1。
- 快攻慢释平滑(amp 0.25/0.04,clip 0.12),避免闪烁。
- 性能:**半分辨率渲染**;WebGL 不可用时静默回退到 body 底色。
- `debug` prop 可打开 4Hz 刷新的指标浮层(rms/peak/ratio/frac/kurt),标定削波阈值时用。

## 5. 样式体系(`src/index.css`,~1500 行)

纯 CSS 拟物,无图片。组织方式(按文件中注释分节):

1. **全局/布局**:`.app`、`.board`(Pedaltrain 金属格栅板,`::after` 做 3D 前缘)、页眉页脚。
2. **控制台**:`.top-bar` 三组分栏、滑杆、电平表、bypass 按钮。
3. **单块**:`.pedal` 金属外壳(渐变 + 内阴影)、`.screw` 螺丝、`.pedal-nameplate` 雕刻铭牌、`.pedal-led` LED 灯座、`.footswitch` 脚踏开关、`.patch-cable` 连接线(含金属插头伪元素)。
4. **旋钮**:`.knob-dial/.knob-body/.knob-indicator/.knob-tick`,旋转角由内联 style 控制,CSS 只负责质感。
5. **皮肤体系**:
   - 单块:`.skin-<effectId>`(如 `.skin-klon`),基色来自内联 CSS 变量 `--pedal-color`(取自 `EffectDefinition.color`),皮肤类只覆写特殊质感(字体、emoji 前缀、特殊渐变)。
   - 箱头:`.amp-clean / .amp-crunch / .amp-recto / .amp-chime`(tolex 纹理、金属包角、面板配色)。
   - 箱体:`.cab-open1x12 / .cab-blue2x12 / .cab-gb4x12 / .cab-v304x12`(网罩纹理、铭牌)。
6. **可视化容器**:`.oscilloscope`、`.fluid-bg`(fixed 全屏垫底)、`.level-meter`、`.mini-meter`。

改外观的原则:**结构类不动,只加/改皮肤类**;新效果器不配皮肤也有可看的默认外壳(`--pedal-color` 驱动)。

## 6. 数据流全景

```
用户操作
  │ 单块/箱头/箱体结构 ──► App setState ──► structureKey 变 ──► effect ──► 引擎 rebuildGraph
  │ 旋钮连续参数 ────────► App setState + audioEngine.updateParam(并行,不经 effect)
  │ 输入源/电平/设备 ────► App 事件处理 ──► audioEngine.useMic/useFile/... + setState
  │ 预设 ──────────────► store.ts 纯函数 ──► localStorage;加载时 setChain(触发通道 A)
  ▼
渲染:App props 下发 ──► 受控组件;AnalyserNode ──► 可视化组件 rAF 读取
```

要点回顾:

- 状态单一来源在 `App`,没有 Context/Redux;组件层级浅,props 直接传。
- React 状态与音频图是**两份各自为政的数据**,靠 §2 的双通道保持一致 —— 改代码时最容易犯的错误是只改一边。
- `StrictMode` 下 effect 会双跑:`init()` 幂等、`rebuildGraph()` 先 dispose 再建,因此是安全的。

## 7. 常见改动指引

- **加一个 UI 面板**:新建受控组件,在 App 加状态 + 事件处理 + 渲染;若影响音频拓扑,把相关字段纳入 `structureKey`。
- **让预设包含箱头/箱体**:扩展 `Preset`(`store.ts`)并处理旧数据兼容(`presetToChain` 的默认值合并模式可参照);保存/加载逻辑在 `App` 的 `handleSavePreset/handleLoadPreset`。
- **接 MIDI/键盘控制**:在事件源回调里直接调 `handleParam` 等价物(setState + `updateParam`),无需碰引擎。
