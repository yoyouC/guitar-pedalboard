# 0001. Worklet 注册按 AudioContext 跟踪(WeakSet),弃用模块级 loaded 标志

## 状态

已采纳(2026-08,issue #3)

## 背景

25 个 worklet 模块用模块级 `let loaded = false` 做幂等(其中 24 个是逐字节
相同的加载尾巴,NAM 是 fetch+shim 变体),首次 `addModule` 成功后置真,
之后幂等返回。looperWorklet 是唯一例外,用的是 `WeakSet<AudioContext>`
按 context 跟踪。

全局标志有一个潜伏缺陷:`AudioContext` 被重建后(如浏览器音频设备切换、
页面热重载),新 context 的 `audioWorklet` 里没有任何 processor,但
`loaded` 仍为真,所有 load 调用直接返回——新 context 静默丢失全部 DSP,
而 worklet 兜底是直通(passthrough-by-design),故障不表现为报错,
只表现为"没声/音色不对"。

## 决定

`src/audio/workletLoader.ts` 提供 `createWorkletLoader(source)` 工厂,
返回的 `load(ctx)` 用每个 loader 自己的 `WeakSet<AudioContext>` 记录
已注册 context:同一 context 幂等,新 context 重新 `addModule`;
`addModule` 成功后才标记,失败向外传播、可重试;Blob URL 在 finally
中 revoke。全部 26 个加载模块(25 个原标志位模块——含 NAM 经异步
source provider 接入——加 looper)都委托到该工厂,模块级 `loaded`
标志全部移除。

NAM 变体通过异步 source provider 接入工厂:每次注册前现取
fetch+shim 拼装的源码,失败同样传播、可重试。

## 后果

- 一处修改,全部 worklet 生效(issue #1 用户故事 1、2)。
- 行为有意偏离旧实现:第二个/重建的 AudioContext 现在会真正注册
  worklet(旧实现静默不注册)。这是修复,不是兼容负担——旧行为
  没有任何调用方依赖(AudioEngine 只有一个 context,且重建场景
  下旧行为是 bug)。
- WeakSet 不阻止 context 被 GC;条目随 context 回收自动消失。
- 注(2026-08):NAM 单块与非 NAM 箱头移除后,委托到该工厂的加载
  模块从 26 个降为 21 个;计数随模块增减,以
  `grep -rl createWorkletLoader src` 为准。
