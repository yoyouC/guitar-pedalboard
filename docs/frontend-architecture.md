# 前端架构

前端是**无路由、无状态库**的单页应用:`main.tsx` → `App.tsx`。Rig 状态的单一事实源是 **rigStore**(`src/state/rigStore.ts`,模块级 pub-sub store,见 ADR-0002);`App` 降为 shell,组件经 `useRig(selector)` 直接订阅自己需要的状态区块。样式集中在唯一的 `src/index.css`。

## 1. 状态模型(rigStore + App shell)

Rig 状态全部在 rigStore(`createRigStore(audioEngine)` 的生产单例在 `src/state/useRig.ts`):

| 状态 | 类型 | 说明 |
|---|---|---|
| `chain` | `ChainItem[]` | 效果链,元素:`{ uid, effectId, enabled, values, post, modelRef?, modelId? }`(`src/state/store.ts`)。`uid` 用 `crypto.randomUUID()` 生成,是 React key 与引擎寻址的双重身份；外部模型身份与稳定 effectId 分离 |
| `presets` | `Preset[]` | 完整 Rig 预设,镜像 localStorage(`guitar-pedalboard-presets`),写盘在 verb 内完成 |
| `ampId/ampEnabled/ampValues` + `ampCategoryId/ampModelKeys` | — | 箱头选择、参数与型号簿记(默认 `crunch` 开) |
| `cabId/cabEnabled/cabValues` | — | 箱体选择与参数(默认 `gb4x12` 开) |
| `namCustomName/namVersion` | — | NAM 自定义模型名与模型版本(换模型 = 结构变化) |
| `inputGain/masterVolume/globalBypass` | — | 全局参数 |
| `snapshots/activeSlot` | — | A/B/C/D 快照槽与激活槽;dirty 是派生 selector(`isSnapshotDirty`),不是存进去的状态 |
| `graphVersion` | number | 图谱重建后自增,供依赖引擎侧节点引用(电平表/背景)的组件重读 |

留在 `App` 的:`inputType/engineReady`、`micDevices/outputDevices/micId/outputId`(设备枚举)、`showMeters/showTuner/ytBgActive`(纯 UI 开关)、MIDI Learn 状态(`midiBindings/learnMode/armedTarget`)。

`state/store.ts` 是纯函数模块:链条实例与浏览器持久化;`state/presetCodec.ts` 是不依赖 DOM/Web Audio 的纯编解码模块。v3 预设覆盖效果链、外部模型引用、箱头、箱体、输入增益、主音量与全局 Bypass,**不存 uid**、加载时重新生成;参数统一按当前目录钳制,并自动把 v2/旧版 chain-only 数据迁移到安全的完整 Rig 默认值。PresetBar 还支持版本化 JSON 批量导入导出。

`state/share.ts` 是 URL 分享编解码(`#p=` + base64url JSON,v2 短字段，兼容读 v1):覆盖**链条 + 外部模型引用 + 箱头分类/型号/参数 + 箱体**(`ShareState`);解码容错——未知 effectId/型号/箱体跳过,参数一律按 ParamDef 范围钳制。rigStore 单例启动时 `readShareFromLocation` 还原一次(无分享参数则用出厂配置 `DEFAULT_RIG_ENCODED`,经 `applyRig` 应用);配置变化由 App 的防抖订阅投影 400ms `writeShareToLocation`(replaceState,不刷历史);PresetBar 的"分享"按钮调同一函数取 URL 复制(clipboard 失败时退化为 prompt)。

## 2. 核心机制:verb 内的状态 ⇆ 引擎同步

这是前端最重要的一段逻辑(`src/state/rigStore.ts`),务必理解后再改:

- **通道 A(结构变化,重建图)**:增删单块、拖拽排序、toggle 单块/箱头/箱体、全局 bypass、换型号、`applyRig`。结构性 verb 内直接调引擎四连 —— `setGlobalBypass → setChain → setAmp → setCab`(每个 setter 内部 `rebuildGraph()`),然后自增 `graphVersion`。没有 `structureKey` 之类的指纹派生。
- **通道 B(参数变化,不重建)**:拧旋钮。param verb(`setPedalParam/setAmpParam/setCabParam/setInputGain/setMasterVolume`)更新 store 状态并直接调 `audioEngine.updateParam` 类方法平滑改音频参数,不重建图,因此没有爆音。
- **恢复路径合一**:预设加载、快照 recall、URL 还原都规范化成 `ApplyRigState` 后走同一个 `applyRig`(`rigFromPreset/rigFromSnapshot/rigFromShare`);快照路径 `ampModel: null` 表示绕过型号机制(ampId 为权威)。

```
用户拖动 Knob → rigStore.setPedalParam(uid,key,v)
                 ├─► store 状态更新(不可变)      // useRig 订阅方重渲染
                 └─► audioEngine.updateParam(...) // 音频图,绕过 React 渲染
```

**新增交互时遵循同一模式**:调 rigStore verb,不要在组件里手写 setState + 引擎双写。

## 3. 组件清单(`src/components/`)

| 组件 | 职责 | 关键点 |
|---|---|---|
| `TopBar` | 输入源切换、输入设备/输出设备选择、GAIN/MASTER 滑杆、IN/OUT 电平表、全局 Bypass | 三组 `console-group`;输出设备选择由 `'setSinkId' in AudioContext.prototype` 特性检测;GAIN/MASTER/Bypass 直接订阅 rigStore |
| `PresetBar` | 完整 Rig 预设保存/加载/删除、JSON 导入导出、URL 分享 | 直接订阅 rigStore,无 props |
| `ChainView` | 横向 pedalboard,**HTML5 拖拽排序** | 本地 `dragIndex/overIndex` 两个 state 管理拖拽态,`onDrop` 调 `rigStore.movePedal(from, to)`;单块间渲染 `patch-cable` 视觉连接线 |
| `PedalCard` | 单个拟物单块:外壳/螺丝/铭牌/LED/脚踏开关/旋钮排 + 迷你电平表 | 旋钮由 `def.params` **自动渲染**;CSS 类 `skin-${def.id}` + CSS 变量 `--pedal-color`;内嵌 `MiniMeter`(canvas,RMS×1.8,绿→橙→红),仅 enabled 时显示 |
| `Knob` | 拟物旋转旋钮 | 垂直拖动(150px 走满量程)、滚轮微调(Shift ×10)、双击回默认、方向键;`role="slider"` + ARIA;`-135°~135°` 指针 + 11 刻度点 |
| `AddEffectMenu` | 链尾"添加效果器"下拉 | 选项直接来自 `EFFECT_REGISTRY`,加新效果器自动出现 |
| `AmpPanel` | 箱头选项卡 + 拟物箱头(品牌牌/宝石灯/旋钮排/电源杆) | 选项来自 `AMP_REGISTRY`;旋钮同样由 `def.params` 驱动 |
| `CabPanel` | 箱体选项卡 + 箱体外观(网罩/铭牌/LEVEL/CAB-DI 开关) | 选项来自 `CAB_REGISTRY` |
| `Oscilloscope` | 双踪示波器:左半 IN 右半 OUT,实时波形 | 读 `inputAnalyser`/`outputAnalyser` 的时域数据,canvas + rAF |
| `RigFooter` | 页脚信号流向文本 | selector 返回字符串,内容不变时不重渲染 |
| `LevelMeter` | RMS 电平表(dB 刻度,-60~0dB 映射,绿→黄→红渐变) | canvas + rAF,只在 analyser 非空时挂载循环 |
| `FluidBackground` / `PrismBackground` | 全屏 WebGL 背景(流体 / Pink Floyd 棱镜,可切换) | 见 §4 |

渲染顺序(App JSX):背景(棱镜或流体,固定垫底)→ 标题 → `TopBar` → `PresetBar` → `ChainView` → `AmpPanel` → `CabPanel` → `Oscilloscope` → 页脚信号流说明。

### 可视化组件的共同点

- 都从 `audioEngine.inputAnalyser / outputAnalyser / getModuleAnalyser(uid)` 拿 `AnalyserNode`,**只读**,不进音频路径。
- 引擎未初始化时 analyser 为 `null`,组件静默(`engineReady` 控制传入)。
- 动画统一 `requestAnimationFrame` 循环 + 卸载时 `cancelAnimationFrame`。

## 4. 全屏背景(WebGL,可切换)

背景有两个主题,App 左下角按钮切换,选择持久化到 localStorage(`guitar-pedalboard-bg-theme`):

- **PrismBackground(默认,Pink Floyd 主题)**:黑底 + 缓转三棱镜,左侧白光射入、右侧色散成彩虹光谱扇出。等边三角形 SDF + 六色光谱渐变;光谱/光束明暗跟随输出响度,色散角随转动轻微呼吸。
- **FluidBackground**:全屏背景,也是"输出信号健康度"的环境指示:
  - 片元 shader:双重 domain-warp 的 fbm 噪声生成流体纹理,暗绿(干净)↔ 橙红(削波)两套配色插值。
  - 每帧从 `outputAnalyser` 读时域数据算两个 uniform:
    - `u_amp`:RMS × 3 截断到 0~1,只影响整体明暗;
    - `u_clip`:削波检测 = `rms / p99峰值` 比值(清音 ≈0.4、失真 ≈0.65~0.75、方波 =1),映射 `(ratio-0.55)/0.15` 到 0~1。
  - 快攻慢释平滑(amp 0.25/0.04,clip 0.12),避免闪烁。
  - `debug` prop 可打开 4Hz 刷新的指标浮层(rms/peak/ratio/frac/kurt),标定削波阈值时用。

两者共用约定:半分辨率渲染省性能;WebGL 不可用时静默回退到 body 底色;`YouTubeBackground` 激活时隐藏。

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
  │ 单块/箱头/箱体结构 ──► rigStore 结构 verb ──► 引擎四连(setGlobalBypass/setChain/setAmp/setCab)──► rebuildGraph + graphVersion++
  │ 旋钮连续参数 ────────► rigStore param verb ──► 状态更新 + audioEngine.updateParam(不重建图)
  │ 输入源/电平/设备 ────► App 事件处理 ──► audioEngine.useMic/useFile/... + App setState
  │ 预设/快照 ──────────► rigStore verb 内写 localStorage;加载经 applyRig 恢复整套 Rig
  │ URL 分享 ───────────► App 防抖(400ms)订阅 rigStore ─► writeShareToLocation
  ▼
渲染:组件 useRig(selector) 订阅 rigStore;AnalyserNode ──► 可视化组件 rAF 读取
```

要点回顾:

- Rig 状态单一来源在 rigStore(ADR-0002),没有 Context/Redux;组件按区块粗粒度订阅(selector 返回原始值或状态内稳定引用),旋钮高频拖动不会引起无关组件重渲染。
- rigStore 状态与音频图靠 verb 内的统一同步保持一致(通道 A/B,见 §2)—— 改代码时走 verb,不要绕开。
- `StrictMode` 下 effect 会双跑:`init()` 幂等、`rebuildGraph()` 先 dispose 再建,因此是安全的。

## 7. 常见改动指引

- **加一个 UI 面板**:新建组件,用 `useRig(selector)` 订阅所需状态区块,交互调 rigStore verb;纯 UI 开关留在 App。
- **接 MIDI/键盘控制**:在事件源回调里调 rigStore verb(参数类 verb 内部已含 `updateParam` 双写),无需碰引擎。
