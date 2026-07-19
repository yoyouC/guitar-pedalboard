# Guitar Pedalboard 开发文档

浏览器端吉他效果器板 + 箱头/箱体模拟。全部音频处理基于**原生 Web Audio API**,无任何音频框架;UI 为 React + 纯 CSS 拟物风格。本文档面向新加入的开发者,目标是读完即可上手改代码。

> 文档以 `main` 最新 commit 为准(撰写时:`f90f436`)。如代码与文档不一致,以代码为准并欢迎更新文档。

## 文档目录

| 文档 | 内容 |
|---|---|
| [audio-architecture.md](./audio-architecture.md) | 音频后端:`AudioEngine`、效果器插件接口、17 款单块、箱头/箱体、如何新增效果器 |
| [frontend-architecture.md](./frontend-architecture.md) | 前端架构:状态模型、UI↔引擎同步机制、组件清单、拟物 CSS 体系、可视化 |

## 快速开始

```bash
npm install
npm run dev      # http://localhost:5173(麦克风输入要求 localhost 或 https)
npm run build    # tsc -b && vite build,产物在 dist/(base './',可部署到任意子路径)
npm run lint     # oxlint
```

其他入口:

- `scripts/render-guitar-riff.mjs`:用 Karplus-Strong 合成内置测试音源 `public/samples/guitar-riff.wav`(`node scripts/render-guitar-riff.mjs` 重新生成)。
- 部署:Vercel(`.vercel/` 已链接项目,`npx vercel --prod`)。

## 技术栈

- React 19 + TypeScript + Vite(无路由、无状态管理库、无 UI 组件库)
- 音频:原生 Web Audio API(`AudioContext` / `BiquadFilterNode` / `WaveShaperNode` / `ConvolverNode` / `AudioWorkletNode` 等)
- 样式:单一 `src/index.css`(~1500 行),纯 CSS 拟物,无图片资源
- 可视化:Canvas 2D(电平表/示波器)+ WebGL shader(流体背景)

## 一图看懂整体架构

```
┌──────────────────────────── React(UI 层)────────────────────────────┐
│  App.tsx 持有全部状态(chain / amp / cab / 输入源 / 电平 / 预设)     │
│    │ 结构变化(增删/排序/开关) ──► audioEngine.setChain/setAmp/setCab │
│    │ 参数变化(拧旋钮) ──────────► audioEngine.updateParam(不重建图) │
└────┬──────────────────────────────────────────────────────────────────┘
     │ 调用(单例 src/audio/AudioEngine.ts)
┌────▼──────────────────────── Web Audio 图 ────────────────────────────┐
│ 输入源(麦克风/文件/测试音源)                                        │
│   → inputGain → inputAnalyser ─┐                                     │
│                                ▼                                     │
│   [效果链: 单块1 → 单块2 → …](每块输出抽一个 AnalyserNode 供电平表) │
│                                ▼                                     │
│   [箱头 amp] → [箱体 cab]      (可各自开关,关闭即直通)              │
│                                ▼                                     │
│   outputAnalyser → masterGain → limiter → ctx.destination            │
└──────────────────────────────────────────────────────────────────────┘
     ▲ AnalyserNode(input/output/每个单块)只读抽头
┌────┴─────────────── 可视化(每帧 rAF 读取)──────────────────────────┐
│ TopBar 电平表 / PedalCard 迷你表 / Oscilloscope / FluidBackground     │
└──────────────────────────────────────────────────────────────────────┘
```

两条核心设计原则:

1. **插件式效果器**:每个效果器/箱头/箱体都实现同一个小接口(`EffectDefinition` + `EffectInstance`),UI 根据 `params` 描述自动渲染旋钮,引擎按接口串联。新增一款效果器只需加一个文件 + 注册一行,无需改动 UI 或引擎。
2. **结构变化才重建图,参数变化只调 `update()`**:React 侧用 `structureKey` 区分两类变化,避免拧旋钮时重建音频图产生爆音。

## 目录结构

```
src/
├── audio/                    # 音频后端(不依赖 React)
│   ├── AudioEngine.ts        # 引擎单例:输入源/效果链/箱头/箱体/输出路由
│   ├── effects/
│   │   ├── types.ts          # EffectDefinition / EffectInstance / ParamDef 接口
│   │   ├── index.ts          # EFFECT_REGISTRY 注册表 + getEffectDef()
│   │   └── *.ts              # 17 款单块,一文件一款,id 即文件名
│   ├── amps.ts               # 4 款箱头(复用效果器接口)
│   ├── cabs.ts               # 4 款箱体(复用效果器接口)
│   ├── noiseGateWorklet.ts   # 噪声门 AudioWorklet(Blob 内联加载)
│   └── impulseResponse.ts    # 程序生成混响 IR
├── state/store.ts            # ChainItem / Preset 模型 + localStorage 持久化(纯函数)
├── components/               # 全部 UI 组件(见 frontend-architecture.md)
├── App.tsx                   # 唯一有状态组件:状态树 + 所有事件处理 + 引擎同步
├── main.tsx                  # 入口(StrictMode)
└── index.css                 # 全部样式:拟物皮肤体系
```
