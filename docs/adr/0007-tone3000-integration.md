# 0007. TONE3000 集成:OAuth PKCE 客户端 + `tone3000:` 型号引用 + NAM 模型源收编

## 状态

已采纳(2026-08,issue #11 及其拆分票 #12-#15)

## 背景

NAM 箱头模型来源有限(内置 wavenet、扫档包、本地 .nam 上传),海量社区
模型在 TONE3000 平台上。同时,NAM 模型选择长期是 namWasm 模块级全局态
(`currentSource`/`currentPack`,架构评审候选 8),`create()` 时偷读,
选择不随 rig 走——`nam-wasm:custom` 的"恢复假定上次上传的源还在"就是
这个坑(ADR-0006 记录为已知限制)。TONE3000 模型是云端引用,可恢复性
(预设/快照/分享)是硬需求,且平台 API 条款要求:不缓存目录、模型仅
在用户请求时**按用户身份**下载、归属展示不可剥离、不可白标。

## 决定

- **API 客户端**:零依赖(OAuth 2.0 + PKCE、令牌轮转、模型获取),
  `createTone3000Client(config)` 工厂,fetch/storage 构造注入(与
  `createRigStore(engine)` 同构);publishable key 作为静态常量随仓
  (官方明确浏览器可公开);refresh token 存 localStorage;过期前 60s
  主动轮转 + 401 强制重放一次;NAM 架构限定 A1+Custom。
- **型号机制扩展**:`AmpModelKind` 新增 `'tone3000'`,modelKey 形如
  `tone3000:{toneId}`;presetCodec 的 normalize 对该前缀按 kind 规则
  放行(不查静态表),categoryId 固定 `'tone3000'`——预设/快照/分享
  存引用,恢复时按用户身份重新下载(与平台条款同构)。
- **NAM 模型源收编(候选 8 最小版)**:`NamModelSelection`
  (`{source} | {pack}`)作为数据随 rigStore 状态与 AmpSpec 传递;
  `createNamWasmAmp(ctx, model)` 不再读模块全局(globals 与两个
  setter 删除);amps.ts 的 `getNamWasmAmpDef` memoized 工厂保证同一
  选择同一 def 实例,graphBuilder 的 def+key 复用语义成立。
  `nam-wasm:custom`(本地文件)保持"保持当前选择"的已知限制。
- **provider 注册点**:namWasm 的 `setTone3000ModelTextProvider` 是
  adapter 注册(下载能力),不是选择状态;生产由 tone3000/instance
  单例注册。`loadModelText` **失败不缓存**(否则未登录时的失败会让
  登录后的重试永远命中缓存的 rejection)。
- **浏览/搜索走平台托管 Select 流程**(免费层条款禁止生产环境用
  `/tones/search`);归属(作者/许可/"Powered by TONE3000" + 链接)
  固定展示;UI、降级路径、trending/粘贴分别为后续票 #13/#14/#15。
- **OAuth 以 popup 流程为主**(#14 UAT 修正:全页跳转 + return-rig
  stash 的链路太脆,用户报告"页面丢失")——主页面不跳转,回调在弹窗内
  经 postMessage 回传(同源校验 + state 校验);弹窗被拦截时兜底为
  全页跳转 + stash。

## 后果

- NAM 模型选择第一次随 rig 序列化通道恢复;候选 8 的"隐藏全局 +
  namVersion 暗号"在箱头装载路径上消解(namVersion 保留作换代键)。
- 每用户模型交付:分享链接不含模型本体,接收方需自己的 TONE3000
  登录(条款要求;降级 UX 在 #14)。
- 平台风险集中在客户端一个 adapter:API v1 可能变化、模型可被作者
  删除/转私有(`tone-unavailable` 错误语义 + #14 的 load_tone 流程)。
- 已知限制:A2 模型被过滤(wasm 核心版本未核对);模型文件仅内存
  缓存;`namDefCache` 设 32 上限(file:/tone3000: 键长期增长)。
