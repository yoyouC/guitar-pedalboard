# CONTEXT

领域术语表(只定义词汇,不记实现细节)。给 issue、重构提案、测试命名时,
优先使用这里的术语,不要另造同义词。

## 信号链角色

- **单块(pedal / effect)**:效果链中的一个效果器单元(压缩、过载、延迟、
  混响等),可添加/删除/拖拽排序/单独 bypass。
- **箱头(amp head)**:效果链之后的放大器级,带 GAIN/BASS/MID/TREBLE/
  PRESENCE/MASTER 六个固定旋钮。
- **箱体(cab)**:箱头之后的频响整形级;关闭即 DI 直通。
- **Rig**:一套完整配置 = 单块链 + 箱头 + 箱体 + 全局控制(输入增益、
  主音量、Bypass),预设系统按 Rig 存取。
- **FX Loop**:标记为 post 的单块排在箱头之后、箱体之前;其余在箱头之前。

## 建模技术

- **NAM(Neural Amp Modeler)**:神经网箱头建模。以 .nam capture 文件为
  模型,在 AudioWorklet 内的 NAM Core(WASM)里推理,覆盖 WaveNet/LSTM
  等全部架构。当前**所有箱头都走 NAM**。
- **WDF(Wave Digital Filter)**:白盒电路建模——按电路原理图逐元件
  离散化(三极管、二极管、BBD 等),与 NAM 的黑盒 capture 相对。
  显示名带 **⚗** 后缀的单块即 WDF 白盒建模款(如 "RAT WDF ⚗");
  "WDF" 字样表示它是某款数字单块的电路建模孪生(如 `ts808` vs
  `ts808wdf`)。过程方法见 `docs/wdf-whitebox-process.md`。
- **capture**:NAM 的模型文件(.nam),对真实设备某一状态的采样快照;
  也泛指"采集"这一行为。

## 注册表

- **效果注册表(effect registry)**:`EFFECT_REGISTRY`,全部单块的
  `EffectDefinition` 有序列表;UI 的添加菜单、单块渲染、预设存取都由它
  驱动。`getEffectDef(id)` 按 id 查找。
- **箱头注册表(amp registry)**:`AMP_REGISTRY`,箱头的同类列表(当前
  只有 NAM 一款定义;音色差异由所选 capture 决定,不在注册表里)。
  `getAmpDef(id)` 按 id 查找。

## 箱头型号寻址

- **型号键(model key)**:`${kind}:${ref}`,kind 只有两种:
  - `nam-wasm:<modelId>` — 内置 capture(`BUNDLED_WAVENET_MODELS`);
    用户本地加载的 .nam 记为 `nam-wasm:custom`。
  - `nam-wasm-pack:<packId>` — 增益扫档包(见下)。
- ~~builtin~~(已移除):曾经的"内置手工建模"箱头(waveshaper/WDF)使用
  `builtin:<ampId>` 寻址;非 NAM 箱头删除后该 kind 不复存在,旧预设/分享
  链接里的 builtin 键会回退到默认型号。
- **分类(category)**:型号归入 4 个分类 tab(Fender Clean / Vox /
  Marshall Crunch / High Gain),分类 id 与皮肤 CSS 类同名
  (`amp-clean/chime/crunch/recto`);每类记住各自选中的型号键。

## NAM 增益扫档包(sweep pack)

同一箱头按增益档位采集多个 capture 组成的包(`NAM_SWEEP_PACKS`):
GAIN 旋钮在档位间做样本级瞬时切换(档位在选中型号时一次性预载),
解决单 capture 的 GAIN 是死值的问题。是"穷人的 parametric":每档精确
但离散,与条件化模型(旋钮作模型连续条件输入)互补。
