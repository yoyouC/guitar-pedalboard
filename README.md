# 🎸 Guitar Pedalboard · 交互式吉他效果器板

在浏览器里运行的吉他效果器板 + 箱头模拟:自由搭建效果链,实时输入音频 → 效果渲染 → 输出。纯 Web Audio API 实现,零音频依赖库。

**在线体验**:https://guitar-pedalboard-indol.vercel.app

## 功能特性

### 效果器单块(17 种)

| 类别 | 效果器 |
|---|---|
| 动态 | Noise Gate(AudioWorklet)、Compressor |
| 过载/失真 | Transparent OD(Klon 风格)、Overdrive、TS808 Drive、Distortion、RAT Dist、Fuzz |
| 哇音 | Auto-Wah(包络跟随) |
| 均衡 | 3-Band EQ |
| 调制 | Chorus、Flanger、Phaser、Tremolo |
| 空间 | Delay、Reverb(程序生成 IR) |
| 输出 | Volume & Pan |

- 经典电路建模:TS808 的 720Hz 中频隆起 + 反馈软削波、RAT 的硅管对地硬削波 + 反向 Filter、Klon 的干声并联混合等
- 拟物单块 UI:旋转旋钮(拖动/滚轮/双击复位)、金属外壳、LED、脚踏开关
- 链条自由配置:添加/删除、**拖拽排序**、单块 bypass、参数实时平滑调节
- 预设:保存/加载/删除链条配置(localStorage)

### 箱头模拟(4 款)

Clean Twin / British Crunch / Modern Recto / AC Chime,位于效果链之后,含前级削波、voicing、音色栈(BASS/MID/TREBLE/PRESENCE)、后级饱和与箱体模拟,MASTER 总音量。

### 输入 / 输出

- 三种输入源互斥切换:**麦克风/线路**(可选设备、关闭回声消除)、**音频文件**(循环播放)、**内置测试音源**(合成 riff,免接琴试听)
- 输入增益、主音量、限幅保护、全局 Bypass;支持选择输出设备(`setSinkId`,浏览器支持时)
- IN/OUT 双路电平表

### 可视化

- **双踪示波器**:左 IN / 右 OUT,实时波形对比
- **沉浸式流体背景**(WebGL):暗绿流体恒定流动,亮度随输出响度起伏;检测到削波时平滑转为橙~红(RMS/P99 波形判据)

## 技术栈

- React 18 + TypeScript + Vite
- Web Audio API(原生节点实现全部效果,无音频框架)
- 纯 CSS 拟物 UI,无图片资源

## 本地开发

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # 产物在 dist/(相对路径,可部署到任意子路径)
```

> 麦克风输入需要安全上下文(localhost 或 https)。

## 部署

```bash
npx vercel --prod   # 已链接 Vercel 项目,直接发布
```

## 项目结构

```
src/
├── audio/
│   ├── AudioEngine.ts      # 音频引擎:输入源/效果链/箱头/输出路由
│   ├── amps.ts             # 4 款箱头模型
│   ├── noiseGateWorklet.ts # 噪声门 AudioWorklet(Blob 内联)
│   ├── impulseResponse.ts  # 程序生成混响 IR
│   └── effects/            # 17 个效果器模块 + 统一接口 + 注册表
├── components/             # 控制台/效果链/单块/旋钮/箱头/示波器/流体背景等
└── state/store.ts          # 链条状态与预设(localStorage)
```

## 版本

当前版本 **v0.0.1** · [GitHub Releases](https://github.com/yoyouC/guitar-pedalboard/tags)
