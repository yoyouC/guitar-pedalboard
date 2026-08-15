# WDF 双拷贝漂移审计清单(issue #7 交付物)

迁移前的逐对盘点:每对 = worklet 内联 JS(实际发声)↔ 纯 TS core(仅 eval
引用)。**权威原则:内联版为准**;提取后的单一源 `*.dsp.js` 与内联版逐位一致
(`tests/wdf-golden.test.ts` 双重路径断言)。本文档记录每对的已知差异与处理,
以及留给维护者裁定的例外。

审计日期:2026-08-15。涉及的 21 个 worklet / 21 个旧 TS core(含共享的
triode、resample)。

## 总结表

| 配对(core ↔ worklet) | 判定 | dsp.js | 关键漂移点 |
|---|---|---|---|
| resample ↔ champ/bogner/twin/jc120 内联 | 完全一致 | resample.dsp.js | 仅命名;注释"31 阶/47 阶"陈旧(实为 48 taps) |
| resample ↔ ac30 内联 | 完全一致(一处等价改写) | resample.dsp.js | Down4 内层 `this.hist.length` vs `NT`,语义等价 |
| triode ↔ champ 内联 | **已漂移(轻微)** | triode.dsp.js | 见例外 1/2;内联多死状态 vkPrev(已弃) |
| triode ↔ bogner 内联 | **已漂移(轻微)** | triode.dsp.js | 同上(champ/bogner 内联逐字符相同) |
| twinStages ↔ twin 内联 | 基本一致 | twinStages.dsp.js | core 多 iter 统计(保留,eval 用);nVt 字面量同例外 2 |
| ac30Core ↔ ac30 内联 | 基本一致,**默认值漂移** | ac30Core.dsp.js | 见例外 3;core 多 gridClamp 开关/iter 统计 |
| jc120Core ↔ jc120 内联 | 完全一致 | jc120Core.dsp.js | 仅封装形态(闭包滤波器 vs 预算系数) |
| diodeClipper ↔ ts808 内联 | 完全一致 | diodeClipper.dsp.js | core 多 options 注入(eval 未用,未保留) |
| ds1Clipper ↔ ds1 内联 | 完全一致 | ds1Clipper.dsp.js | 同上 |
| ratDistortion ↔ rat 内联 | 完全一致 | ratDistortion.dsp.js | Rdist 初值写法 `0.55*RdistMax` vs `55e3`,数值相等 |
| bigmuff ↔ bigmuff 内联 | 完全一致 | bigmuff.dsp.js | BigMuffChain 仅 core 有(eval API,平移);MuffTone.inv Float64Array→Array(内联为准) |
| fuzzFaceStage ↔ fuzzface 内联 | **已漂移** | fuzzFaceStage.dsp.js | 见例外 4(starve 重解 DC) |
| crybabyStage ↔ crybaby 内联 | 完全一致 | crybabyStage.dsp.js | 仅结构写法;core 多 nodeVoltages getter(保留) |
| klonCentaur ↔ klon 内联 | 基本一致 | klonCentaur.dsp.js | core 的 klonGainForKnob/klonDryCoeff 有 clamp01,内联无(内联为准) |
| fetComp ↔ fet1176 内联 | 完全一致 | fetComp.dsp.js | level clamp 0..4(core)/0..2(descriptor),见观察项 |
| la2aOpto ↔ la2a 内联 | 完全一致 | la2aOpto.dsp.js | 仅构造签名 |
| dynaComp ↔ dynacomp 内联 | 完全一致 | dynaComp.dsp.js | 内联 = core 默认配置死写版 |
| analogDelay ↔ analogdelay 内联 | 完全一致 | analogDelay.dsp.js | 仅构造签名;噪声覆盖注意点见下文 |
| tapeDelay ↔ tapedelay 内联 | 完全一致 | tapeDelay.dsp.js | 仅常量命名 |
| pingPongDelay ↔ pingpong 内联 | 完全一致 | pingPongDelay.dsp.js | 类名不同(PingPongDelayCore→PingPongDelay);构造补 `= 1500` 默认(行为安全) |
| springReverb ↔ springreverb 内联 | 完全一致 | springReverb.dsp.js | core 多未使用的 OnePoleLP.setFc() 死代码(已弃) |
| plateReverb ↔ plate 内联 | 完全一致 | plateReverb.dsp.js | 仅类名(PlateReverbCore→PlateReverb) |
| shimmerReverb ↔ shimmer 内联 | 完全一致 | shimmerReverb.dsp.js | 仅构造签名 |

## 留给维护者裁定的例外

以内联版为准提取意味着以下"core 侧看似 bugfix / 改进,但内联版(用户实际
听到的)没有"的差异**没有**随迁移合入。逐条裁定;若采纳 core 行为,另开 PR
修 bug(会改变音色,需重录黄金基线:`node scripts/wdf-golden-record.ts`)。

### 例外 1:champ/bogner 的栅流钳位仍是已知会翻车的阻尼定点

ac30Core 的注释(已平移至 `triode.dsp.js` 的 `WdfTriodeStage` 类注释)明确判定:
标准 `TriodeStage` 的阻尼定点 solveGrid 在 vgSrc−vk > ~0.83V 时被指数栅流
踹到 −16kV,板流归零,深激励下与耦合电容充放电形成 period-2 极限环
(AC30 链 g50/0.3V 曾复现 THD 5920%)。ac30(二分 14 次)与 twin(二分 20 次)
两链已改用二分变体修复,但 **champ/bogner 的 4 份拷贝(2 内联 + triode.ts
core)均未修**,本次以内联为准保留了旧实现。
裁定问题:champ/bogner 的驱动电平是否安全?若否,统一为二分变体(音色会变)。

### 例外 2:栅流二极管 nVt 字面量 0.0414 vs 0.04136

所有内联版栅流 nVt 用字面量 `0.0414`;所有 TS core 用 `1.6 * 25.85e-3`
(= 0.04136,triode.ts 注释称与 spice DGRID 一致)。差 ~0.1%,单一源以内联
0.0414 为准(triode.dsp.js、twinStages.dsp.js、ac30 变体同)。
裁定问题:core 的 0.04136 是否才是与 spice 标定一致的正确值?

另:栅流二极管存在三种变体——`Is·(e^x−1)` 封顶 20(triode/ac30 家族)、
`Is·e^x` 无 −1 项封顶 30(twin 家族)。pair 内部各自一致,已原样保留;
是否统一由维护者裁定。

### 例外 3:AC30 默认参数双标

已删除的 ac30Core.ts 的 `Ac30Chain` 构造默认 `gain=35`、音色全 50;worklet
parameterDescriptors 默认 `gain 30, bass 50, mid 55, treble 60, presence 55`。
两边都未改动:`ac30Core.dsp.js` 的 `Ac30Chain`(eval API)保留 core 默认值,
发声路径默认由 descriptor 决定(30/50/55/60/55)。
裁定问题:哪组是意图默认值?统一后更新另一侧。

### 例外 4:fuzzface starve 路径:Vcc 变化时是否重解 DC

内联版(单一源现状):setFuzz 中 Vcc 变化即重新 `solveDC()` 并重置全部电容
状态。已删除的 core 版刻意**不重解**,注释理由:让偏置像真实电源跌落一样在
数毫秒内自然迁移,重解会打乱电容状态。
可观察后果:`scripts/wdf-fuzzface-eval.ts` 的 L0 扫掠(逐样本变 fuzz)在新
实现下 `nonConverged=12233`(旧 core 为 0)——该检查已降级为警告输出并注明
本例外,待裁定后决定断言去留。
裁定问题:采纳 core 的"不重解"(更像 dying-battery,但要改音色)还是维持
内联现状(听感已定型)?

## 观察项(非例外,记录在案)

- **wrapper 同构程度**(issue 用户故事 14):21 个 wrapper 现在形态高度一致
  (buildProcessorSource + descriptor + 委托 + registerProcessor),差异仅在
  crybaby 的 suspend/port 处理。值得做模板统一的话另立候选。
- **参数缓存策略各不相同**(行为等价,未统一):ts808/ds1/rat/dynacomp 有
  脏检查;twin/ac30 有块率缓存(lastTone);plate 缓存在核 setter 内;shimmer
  缓存四元组;spring/tapedelay 每块无条件重算。
- **mix 归属**:spring 的干路恒 1 线性叠加在引擎(原 wrapper);plate/shimmer
  的等功率交叉在核内。各自原样保留。
- **fet1176 level 上限**:核 setLevelGain clamp 0..4,descriptor 0..2——
  UI 域更窄,无行为影响。
- **pingpong feedback**:descriptor maxValue=90,核 setFeedback 钳 0.98——
  UI 域更窄,无行为影响。
- **注册名风格不一**:`'opto-la2a'`、`'plate-reverb'`、`'bbd-analog-delay'`、
  `'pingpong-delay'` 不带 `wdf-` 前缀——原样保留(改名会断既有会话/预设)。
- **analogdelay 黄金样本的噪声覆盖**:BBD 本底噪声用 `Math.random()`
  (NOISE_AMP=3e-4),非定种子。fixture 窗口(4096 样本 ≈ 85ms)短于默认延迟
  (300ms),读指针在窗口内只读到未写入的零区,噪声不影响断言输出,故逐位
  断言稳定成立;但噪声路径本身不在黄金覆盖内,且更长窗口下 fixtures 将不可
  复现——这是该方案的固有前提。
- **陈旧注释已顺手修正**:triode.ts 头"栅流钳位留待后续"(与实现矛盾)、
  resample "31 阶/47 阶"(实为 48 taps)——随单一源提取修正;core 注释
  "Vcc 9→4.5V" 笔误(实际 4.0V)随删除消亡。

## 机制说明

- 黄金样本:迁移前用 `scripts/wdf-golden-record.ts` 从各 worklet 内联串
  录制(readFileSync + shim 实例化,whammy-eval 手法),输入为脉冲 /
  对数扫频(20Hz→15kHz,幅 0.3)/ 白噪声(±0.3,mulberry32 种子 42),
  各 4096 样本 @48kHz,descriptor 默认参数,Float32 二进制存
  `tests/fixtures/wdf/`(21 效果 × 3 信号,共 ~1MB)+ manifest.json。
- 断言:`tests/wdf-golden.test.ts` 随 `npm test` 自动运行,每效果两条路径
  逐位(Object.is)断言:① 直接 import `*.dsp.js` 引擎类驱动;② 按 worklet
  的 ?raw import 列表 + wrapper 模板用 `buildProcessorSource` 重建实际发给
  AudioWorklet 的完整字符串,shim 实例化驱动。
- 重录基线:裁定例外导致行为变化时,`node scripts/wdf-golden-record.ts`
  重录(对已迁移 worklet 走 ?raw 装配形态,同一 harness)。
