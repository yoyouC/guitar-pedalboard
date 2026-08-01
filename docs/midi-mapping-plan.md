# MIDI 键盘映射 & 实现计划(Synido TempoKEY K25)

> 分支:`feature/midi-mapping`(worktree:`../guitar-pedalboard-midi`)
> 状态:计划已确认，待实现

## 1. 设备调研:Synido TempoKEY K25

通过 USB 已识别到设备(`system_profiler`:Synido TempoKEY K25,Vendor 0x0416 / Product 0x0206)。硬件控件(来源:[Synido 官方产品页](https://www.synido.com/en-gb/products/synido-midi-keyboard-controller-25-keys-with-drum-pads-beat-maker-machine-tempokey-k25-midi-controller)、[Juno Daily 评测](https://www.juno.co.uk/junodaily/2026/06/05/synido-tempokey-k25-review/)):

| 控件 | 数量 | 说明 |
|---|---|---|
| 琴键 | 25 | 带力度，可八度/半音移调；发 Note On/Off |
| 打击垫 | 8 × 2 Bank | 带背光力度感应;Pad Bank A/B 共 16 个指派；每个垫可配为 NOTE / CC / PC |
| 旋钮 | 8 × 2 Bank | 可分配 CC;Knob Bank A/B 共 16 个指派 |
| 走带键 | 6 | Stop / Play / Rec 等，发 CC |
| 触控条 | 2 | Pitch Bend、Modulation(CC1) |
| 主控旋钮 | 1 | 360° 按压旋钮 + OLED，用于设备自身菜单 |

**关键前提:K25 的所有旋钮/打击垫 CC、Note 编号均可在 Synido 控制软件或设备菜单里由用户改配**，出厂默认值不保证可靠。因此实现必须做到:

1. 映射表数据驱动，集中在一个文件里，改编号只改一处;
2. 附带一个 MIDI 监视器(调试面板)实时显示收到的原始消息，首次接入时核对实际编号;
3. 后续(Phase 2)做 MIDI Learn，用户点 UI 控件后转动旋钮即可绑定。

## 2. 现有快捷键(要被镜像/扩展的功能)

全局快捷键集中在 `src/App.tsx` 的 `keydown` 监听(约 398–432 行):

| 电脑键盘 | 动作 | 派发入口 |
|---|---|---|
| `Space` | 全局 Bypass | `setGlobalBypass(b => !b)` |
| `Q/W/E/R` | 召回快照 A/B/C/D | `recallSnapshot(0..3)` |
| `1`–`9` | 切换效果链第 N 块单块开关 | `handleToggle(uid)` |

鼠标-only、值得一并映射的功能:

- Looper:`audioEngine.startLoopRecording / finishLoopRecording / toggleLoopPlayback / clearLoop` 等(`src/audio/AudioEngine.ts:526-559`)，自带 `canRunLooperCommand` 状态守卫(`src/audio/looperState.ts:39`)
- 参数调节:`handleParam(uid, key, value)`(App.tsx:321-328)、`handleAmpParam`、`handleCabParam`
- 全局:`inputGain`、`masterVolume`

MIDI 层只调这些既有派发函数，不碰引擎内部(`docs/frontend-architecture.md:124` 已指明这一集成点)。

## 3. 键位映射方案(默认表，可改)

### 3.1 打击垫(Note 消息)—— 单块开关 + 快照，对齐现有快捷键

| Pad(Bank A) | 动作 | 对应键盘 |
|---|---|---|
| Pad 1–8 | 切换效果链第 1–8 块单块 | `1`–`8` |
| Pad 1–4(Bank B) | 召回快照 A/B/C/D | `Q/W/E/R` |
| Pad 8(Bank B) | 全局 Bypass | `Space` |

### 3.2 走带键(CC,出厂编号已按说明书核对)—— Looper

| 按键 | CC(出厂) | 动作 |
|---|---|---|
| Record | 26(Toggle,每次按下交替发 127/0,均触发) | 录音开始/结束(`startLoopRecording` / `finishLoopRecording`) |
| Play/Pause | 25(Toggle,同上) | 播放/停止(`toggleLoopPlayback`) |
| Stop | 24(Momentary,按下值>0 才触发) | 清除 Loop(`clearLoop`) |

### 3.3 旋钮(出厂编号已按说明书核对:Bank A K1..K8 = CC#01..08)

| 旋钮 | CC | 动作 |
|---|---|---|
| 主音量旋钮 | 7(说明书未载,按标准音量号初值,**待实机核对**) | Master 输出音量 |
| K2–K6 | 02–06 | 音箱 gain / bass / mid / treble / presence(0–100) |
| K8 | 08 | 音箱 master(-30..+6 dB) |
| K1 | 01 | 预留(与 Modulation 触控条出厂 CC#01 同号,避免误触) |
| K7 | 07 | 预留(与主音量旋钮疑似同号;核对前 CC07 统一按主音量处理) |

0–127 线性映射到参数范围(`ccToRange`)。核对方式:TopBar MIDI 指示 → 展开监视器,转动对应旋钮看实际 CC 号,不一致改 `src/midi/midiMapping.ts` 顶部常量。

### 3.4 不映射(默认)

- 25 个琴键:语义是音符输入，默认不绑定；未来可扩展(如最低八度白键触发快照、哇音踏板表情)
- Pitch/Mod 触控条:预留给表情类效果(哇音/颤音深度),Phase 2 再议

## 4. 实现计划

不引入任何新依赖——Web MIDI 是浏览器原生 API(`navigator.requestMIDIAccess`,Chrome/Edge 支持良好；需用户授权；Safari/Firefox 不支持，UI 上优雅降级隐藏入口)。

### Phase 1(MVP，本次实现)

1. **`src/midi/midiMessage.ts`** — 纯函数:解析 `MIDIMessageEvent` → `{ type: 'note' | 'cc', channel, number, value }`。
2. **`src/midi/midiMapping.ts`** — 默认映射表(第 3 节)+ 纯函数 `resolveMidiAction(msg): MidiAction | null`。映射表数据驱动，编号集中可改。
3. **`src/midi/useMidi.ts`** — React hook:`requestMIDIAccess({ sysex: false })`、监听 `statechange` 热插拔、遍历 inputs 挂 `onmidimessage`,解析 → `resolveMidiAction` → 调回调。hook 入参为 App.tsx 传入的一组 action 回调(`togglePedal`、`recallSnapshot`、`toggleBypass`、`setInputGain`…),返回 `{ supported, enabled, deviceName, lastMessage }`。
4. **`src/App.tsx`** — 调用 `useMidi`,把现有 `handleToggle`/`recallSnapshot`/`setGlobalBypass`/`handleAmpParam` 等包一层传入；新增 `handleMidiParam` 时复用 `handleParam` 模式(setState + `audioEngine.updateParam`)。
5. **`src/components/MidiStatus.tsx`** — TopBar 里的小指示:未支持/未连接/已连接(设备名)，点击展开最近一条原始 MIDI 消息(兼任第 1 节要求的调试监视器，核对实际 CC/Note 编号)。
6. **测试 `tests/midi-mapping.test.ts`** — 对照 `tests/preset-codec.test.ts` 风格：消息解析、映射表命中/未命中、CC 值 0–127 → 参数范围换算。
7. 验证:`npm run build` + 测试通过；浏览器实测 K25(需要用户授权 MIDI 访问)。

### Phase 2(后续，不在本次)

- MIDI Learn:点 UI 上的旋钮/按钮进入学习态，下一次 MIDI 输入即绑定，映射持久化到 localStorage(复用 `src/state/store.ts` 的持久化模式)
- 琴键/触控条扩展映射、力度映射到参数

### 文件清单(新增)

```
src/midi/midiMessage.ts      新增,~40 行
src/midi/midiMapping.ts      新增,~80 行
src/midi/useMidi.ts          新增,~90 行
src/components/MidiStatus.tsx 新增,~50 行
tests/midi-mapping.test.ts   新增
src/App.tsx                  改 ~20 行(挂 hook + 传入回调)
src/components/TopBar.tsx    改 ~5 行(放 MidiStatus)
```
