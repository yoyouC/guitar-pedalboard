# 白盒电路建模(WDF)开发与验证流程

> 本文记录 Guitar Pedalboard 项目中白盒(基于电路原理)吉他设备建模的方法论、
> 实现架构与正确性验证体系。白盒路线与 NAM 神经网络黑盒路线并存于同一台架。

## 1. 建模方法

### 1.1 离散化:伴随模型 / 梯形积分(等效双线性 WDF)

每个线性元件用梯形积分(trapezoidal / bilinear transform)离散为"伴随模型",
与 Wave Digital Filter 的双线性波变量形式数学等价:

| 元件 | 离散模型 |
|---|---|
| 电阻 R | 阻值不变 |
| 电容 C | 电导 `Gc = 2C/T` + 历史电流源 `Ih[n] = -Gc·v[n-1] - i[n-1]` |
| 电压源 + 内阻 | 戴维南等效 |

非线性元件(电子管/二极管)作为树根,**每个音频样本用 Newton 迭代解单变量
非线性方程**,带数值/解析 Jacobian、步长阻尼与初值沿用上一样本结果。

### 1.2 器件模型

- **三极管(12AX7 / 6V6 / EL34 近似)**:Koren 静态模型
  `Ip = E1^Ex / Kg`,`E1 = (Vpk/Kp)·softplus(Kp·(1/mu + Vgk/√(Kvb+Vpk²)))`
  参数(mu/Ex/Kg/Kp/Kvb)按型号查表(`src/audio/wdf/triode.ts`)
- **栅流钳位**:二极管指数模型 `ig = Is·(e^(vgk/nVt) - 1)`,
  **隐式内嵌 Newton**(见 §4.4),源内阻 Rs 分压产生钳位与 sag
- **二极管钳位(TS808)**:反并联 1N4148 对 `Id = 2·Is·sinh(Vd/(n·Vt))`
  (Is=2.52nA, nVt=45.3mV,文献标准值)

### 1.3 抗混叠重采样

非线性处理在 **4x 过采样**下进行:

- 升采样:多相分解(4 相 × 12 tap)
- 降采样:48 阶 Blackman-sinc FIR(截止 17.3kHz,镜像区抑制 ≥77dB)
- 实测镜像能量比 -66dB(线性插值方案为 -49dB)

### 1.4 AudioWorklet 集成要点

- 处理器源码以 **IIFE 包裹**——同一 AudioContext 的所有 worklet 共享全局作用域,
  顶层同名声明会导致注册失败(曾致 Bogner 静默直通)
- **每通道独立链路状态**(早期共享状态导致立体声串扰)
- 引擎启动时统一预加载全部 worklet,各自 try/catch 兜底直通

## 2. 验证体系(L0~L4)

原则:**任何白盒模型都必须通过离线数值验证才可上线**。DSP 核心不依赖浏览器,
全部测试在 Node 完成(`node --experimental-strip-types` 直跑 TS)。

| 级 | 内容 | 通过判据 |
|---|---|---|
| **L0 求解器健康** | 无 NaN、输出有界、Newton 平均迭代数、静音→静音(无极限环) | 全过 |
| **L1 静态传输** | 慢扫输入,削波曲线形状、连续性、对称性 | 形状/阈值/对称度达标 |
| **L2 线性区频响** | 小信号扫频,对照文献极点(如 TS 的 720Hz HP / 723Hz LP) | 极点位置 ±10% |
| **L3 非线性行为** | THD 随 drive 单调性、谐波构成(奇/偶比)、频率选择性失真 | 定性符合电路文献 |
| **L4 参考对比** | **ngspice golden reference** 同电路瞬态仿真,样本级对齐 RMSE + RMS/峰值/THD 行为指标 | RMSE / 电平差阈值 |

### 2.1 辅助测量

- **混叠测量**:精确整数周期正弦 + DFT,统计非谐波 bin 能量比(消除泄漏)
- **动态包络测试**:拨弦包络/阶跃电平,检查 sag、恢复、贴轨时间
- **频谱边带检查**:载波 ±Δf 边带强度(捕捉 motorboating 等低频寄生振荡)

### 2.2 工具链

```bash
npm run wdf:test          # 三极管级 / Champ / Bogner 链稳定性 + 混叠对比
npm run wdf:ts-eval       # TS808 L0~L3
npm run wdf:ts-spice      # TS808 L4(vs ngspice,RMSE 0.8%)
node scripts/wdf-bogner-spice-compare.ts  # Bogner L4 多档
```

SPICE 参考网表在 `scripts/spice/`(Koren B-source 子电路 + 理想运放/缓冲)。

## 3. 当前模型与验证结果

| 模型 | 结构 | L4(vs ngspice) |
|---|---|---|
| **WDF Champ** | 5F1 风格:2×12AX7 + 6V6 单端 + 变压器 | — |
| **WDF Bogner** | Ecstasy 高增益:3×12AX7 级联(含冷偏置级)+ EL34 | RMS 差 1.7~2.3dB,低增益 THD 精确一致(0.6%/0.6%) |
| **TS808 WDF ⚗** | 运放+二极管对 WDF + 音色级 | **RMSE 0.8%**(峰值差 1mV) |

## 4. 已踩过的坑(经验教训)

### 4.1 AudioWorklet 全局作用域冲突
症状:第二个 worklet 注册失败,箱头静默直通(Gain 拧到最大仍是清音)。
根治:处理器源码一律 IIFE 包裹。

### 4.2 建立期瞬态污染测量
耦合电容充电时间常数 ~22ms,建立期 <5τ 时 DC 偏移会严重歪曲增益/THD 测量。
规范:数值测量一律先跑 ≥0.5s 建立期(spice 侧 ≥100ms)。

### 4.3 测量方法论
- DFT 频率必须取采样窗整数倍,否则泄漏淹没镜像测量;
- 降采样器建立期也要每样本都走,否则 FIR 历史为空;
- THD 用基波幅度(Goertzel)而非峰值/RMS,避免 DC 与波形误读。

### 4.4 栅流钳位的三次迭代
硬分压(0.7V 阈值)→ 二极管指数模型 → **隐式内嵌 Newton**:
延迟一个样本的栅压会产生极限环(非谐波噪声);隐式求解后稳定。
注意:弛豫振荡(motorboating,载波 ±6Hz 边带)是**物理现象**——
spice 参考电路同样出现,治理用经典疗法:耦合电容 22nF→4.7nF
(低频转角 7.2Hz→34Hz,边带强度 0.455→0.055)。

### 4.5 spice 参考侧的陷阱
- ngspice 首行是标题(跳过),网表必须以注释行开头;
- `.print` 输出分列多张表,按表头列名解析;
- 集总滤波器级间有负载效应(我们的变压器 HP 被 LP 的 1k 阻抗拖垮),
  级间需要单位增益缓冲;
- 栅流用 `max()` 硬折线会让求解器爆炸,必须换平滑二极管。

## 5. 目录结构

```
src/audio/wdf/
├── triode.ts          # 共阴极三极管级(TS 参考实现,Node 可测)
├── diodeClipper.ts    # TS808 运放+二极管对 WDF 级
├── resample.ts        # 4x 多相升采样 + 48 阶 FIR 降采样
├── champWorklet.ts    # WDF Champ 处理器(IIFE 内联)
├── bognerWorklet.ts   # WDF Bogner 处理器
└── ts808Worklet.ts    # TS808 WDF 处理器
scripts/
├── wdf-test.ts        # 链稳定性 + 混叠对比
├── wdf-ts-eval.ts     # TS808 L0~L3
├── wdf-ts-spice-compare.ts      # TS808 L4
├── wdf-bogner-spice-compare.ts  # Bogner L4 多档
└── spice/             # ngspice 参考网表
```

worklet 内联 JS 与 `triode.ts`/`resample.ts` 的 TS 参考实现保持逻辑一致——
**改动必须两边同步**(worklet 无法 import,故内联)。
