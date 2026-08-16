# 0003. WDF DSP 单一来源:纯 JS `*.dsp.js` + `?raw` 双模式 import,内联版为权威

## 状态

已采纳(2026-08,架构评审候选 3)

## 背景

`src/audio/wdf/` 的每个 WDF 算法存在两份拷贝:纯 TS core(仅被
`scripts/*-eval.ts` 引用)与 worklet 文件里手工转抄的内联 JS 字符串
(实际发声),靠 30+ 处"改动请两边/三边同步"注释维持。共 20 对、约
3000 行重复;三极管求解实际约 5 份。盘点发现拷贝**已经漂移**
(triode:内联版 nVt 硬编码、缺 `gridClamp`、多 `vkPrev` 状态)——
eval 验证的代码与用户听到的代码已不是同一个算法。`resample.ts`
共享助手被分别内联进 5 个 worklet。

## 决定

- 每个 DSP 核转为纯 JS + JSDoc 的 `foo.dsp.js`,与 worklet 同目录。
  worklet 侧 `import src from './foo.dsp.js?raw'` 取字符串拼装进
  Blob(ADR-0001 的 per-context 加载语义不变);eval/测试侧正常
  `import` 执行。先例:`namWasmProcessor.js`。
- 原 `.ts` core 全部删除;eval 脚本 import 改指 `.dsp.js`。
- **权威原则:内联版(用户实际听到的)为默认权威**,音色零变化是
  硬约束;完整漂移审计逐对进行,例外(内联版缺 core 侧 bugfix)
  逐对标记由维护者裁定,漂移清单随 PR 交付。
- 切分线只到 DSP 核;worklet wrapper(parameterDescriptors、通道
  循环、registerProcessor)各文件保留,同构程度记录为观察项,统一
  与否另议。
- ac30 有意分叉的 `WdfTriodeStage` 变体(二分法栅流钳位)作为
  `triode.dsp.js` 的第二个导出类,分叉原因注释平移。
- 迁移前从当前内联字符串录黄金输出(脉冲/扫频/白噪声)存
  `tests/fixtures/wdf/`;迁移后 `tests/wdf-golden.test.ts` 逐位
  (或 1e-12 容差)断言,随 `npm test` 自动跑;外加浏览器手动
  A/B 听音。

## 后果

- 验证的代码 = 发声的代码;DSP bug 修一处即处处生效,30+ 处同步
  注释这份隐形契约删除。
- worklet DSP 首次可被 import 进 `node:test`。
- 代价:DSP 核从 TS 退为 JSDoc 纯 JS,且 tsconfig 未开 `checkJs`,
  JSDoc 类型不受 tsc 校验(与 `namWasmProcessor.js` 现状一致)。
  这些核是纯数值计算,类型收益有限,接受。
- `scripts/` eval 保持手动运行,不进 `npm test`,不引入 CI。
- 单 PR 一次全迁 20 对;黄金样本先于迁移录制,保证大 diff 可验证。
