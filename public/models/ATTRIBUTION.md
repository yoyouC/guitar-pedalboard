# 内置 NAM 模型来源与许可

本目录模型文件均为第三方制作的 Neural Amp Modeler capture,仅供本地评估;
**公开发布/再分发前请核对各自许可**。

| 文件 | 说明 | 来源 | 许可 |
|---|---|---|---|
| `lstm-demo.nam` | NAM Core 官方测试 capture(Darkglass Microtubes 900 v2,clean,H=3) | [sdatkinson/NeuralAmpModelerCore](https://github.com/sdatkinson/NeuralAmpModelerCore) `example_models/lstm.nam` | MIT |
| `BossLSTM-1x16.nam` | Boss LSTM capture(1 层 ×16,OD/驱动类) | [mikeoliphant/NeuralAudio](https://github.com/mikeoliphant/NeuralAudio) `Utils/Models/BossLSTM-1x16.nam` | **CC BY-NC-ND 4.0**(勿再分发) |
| `BossLSTM-2x16.nam` | 同上,2 层 ×16(原文件来自 neural-amp-modeler-lv2,同一模型) | [djshaji/neural-amp-modeler-lv2](https://github.com/djshaji/neural-amp-modeler-lv2) `models/BossLSTM-2x16.nam` | GPL-3.0 / 同上 CC 系列,待核 |
| `DeluxeReverb-3x24.nam` | Fender Deluxe Reverb(clean,3 层 ×24) | [skykooler/Lightningbeam](https://github.com/skykooler/Lightningbeam) `src/assets/nam_models/DeluxeReverb.nam` | **GPL-3.0** |
| `reference-lstm-2x16.nam` | nam-rs 测试基准 LSTM(2 层 ×16,48kHz) | [OpenSauce/nam-rs](https://github.com/OpenSauce/nam-rs) `tests/fixtures/reference_lstm_standard.nam` | MIT |
| `ac10-wavenet.nam` | Vox AC10 WaveNet capture(方案 B 内置) | [tone-3000/neural-amp-modeler-wasm](https://github.com/tone-3000/neural-amp-modeler-wasm) `ui/public/models/ac10.nam` | 未标明,仅本地评估 |
| `deluxe-wavenet.nam` | Fender Deluxe Reverb WaveNet capture(方案 B 内置) | 同上 `ui/public/models/deluxe.nam` | 未标明,仅本地评估 |
| `namknobs/*.nam`(comp/ts_full/rat/gr/ds1/ff/mxr) | NAMKnobs 条件化单块(upstream_v2,旋钮=条件输入通道) | [drockthedoc/NAMKnobs](https://github.com/drockthedoc/NAMKnobs) `offline_cond_nam/out/upstream_v2/` | **未标明(仓库无 LICENSE),仅本地评估,勿再分发** |
| `jcm2000-clean.nam` / `jcm2000-crunch.nam` / `jcm900-dualverb-g12.nam` / `jcm900-dualverb-g16.nam` | Tim R 的 Marshall JCM2000/JCM900 系列 capture | [pelennor2170/NAM_models](https://github.com/pelennor2170/NAM_models) | **GPL-3.0** |
| `helga-5150-blockletter.nam` / `helga-6505-red.nam` | Helga B 的 Peavey 5150/6505+ capture | 同上 | **GPL-3.0** |
| `fender-twinverb.nam` / `peavey-5152-clean.nam` | Tim R 的 Fender TwinVerb / Peavey 5152 清音 capture | 同上 | **GPL-3.0** |
| `vox-ac15.nam` | Phillipe P 的 Vox AC15(JonAr1)capture | 同上 | **GPL-3.0** |
| `friedman-shirley-clean.nam` | Sascha S 的 Dirty Shirley Mini 清音 capture | 同上 | **GPL-3.0** |
| `laney-gh100s.nam` | Phillipe P 的 Laney GH100S(Iommi 签名款)crunch capture | 同上 | **GPL-3.0** |
| `marshall-sweep/*.nam`(g1.0~ga10,含 SlimmableContainer) | JCM800-2203 高增益通道增益扫档 capture 包(11.4dBu 标定,另有 3 个 SD1 boosted 变体未入库) | 用户自有文件(Desktop 的 `Marshall JCM800 2203 - updated.zip`,原始作者未考证) | 未标明,仅本地评估 |
| `bassman-sweep/` `dualterror-sweep/`(各 8 档) | Fender Bassman 50 JUMPED / Orange Dual Terror TT 增益扫档包(ArlingtonAudio) | 用户自有的 NAM箱头模型合集 zips(作者见包内目录名:ArlingtonAudio/ObiJuan/NorthernFox 等) | 未标明,仅本地评估 |
| `evh-green-sweep/` `recto-red-sweep/`(各 8 档) | EVH 5150 50W 6L6 Green 555 / Mesa Dual Rectifier EL34 Modern Red 增益扫档包 | 同上 | 未标明,仅本地评估 |
| `bug1990-lead.nam` | Phillipe P 的 Bugera 1990(JCM800 风格)Lead capture | 同上 | **GPL-3.0** |
| `sovtek-mig50.nam` | Mikhail K 的 Sovtek MIG50 capture | 同上 | **GPL-3.0** |
| `orange-rockerverb.nam` | Tom C 的 Orange Rockerverb(Axe FX 2)capture | 同上 | **GPL-3.0** |
| `snapshot-pedals/*.nam`(boss-sd1/fortin-grind/klone) | 快照单块:BOSS SD-1(Phillipe P)、Fortin Grind(Tudor N)、Klone(Keith B) | 同上 | **GPL-3.0** |

注:曾内置 openDAW 的 `[PRE] JCM800-2203-MODIFIED-HI` 两个模型,实测为哑弹
(输出与输入电平脱钩、高频占比异常,疑似测试用生成物,metadata 为占位符),已移除。

注:以上模型按 NAM 惯例均为 48kHz 采样率训练。BossLSTM 系列在多个仓库中流转,
上游作者为 NAM 社区;DeluxeReverb 无 loudness 元数据,输出电平可能偏低。
