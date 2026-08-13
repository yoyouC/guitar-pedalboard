/**
 * worklet 加载器工厂:取代各 *Worklet.ts 末尾复制的加载尾巴。
 *
 * 语义(与 looperWorklet 原有实现一致,见 docs/adr/0001):
 * - 注册按 AudioContext 跟踪(每个 loader 一个 WeakSet):
 *   同一 context 重复 load 幂等;换了新 context 会重新 addModule——
 *   旧实现用模块级 `loaded` 标志,重建 context 后会静默丢失全部 DSP。
 * - addModule 成功后才标记已注册;失败错误向外传播,可重试。
 * - Blob URL 在 finally 中 revoke。
 *
 * source 可以是 processor 源码字符串,也可以是异步取源函数
 * (NAM 的 fetch+shim 变体用它:每次注册前现取,失败同样传播、可重试)。
 */
export type WorkletSourceProvider = () => string | Promise<string>;

export function createWorkletLoader(
  source: string | WorkletSourceProvider,
): (ctx: AudioContext) => Promise<void> {
  const loadedContexts = new WeakSet<AudioContext>();
  return async function loadWorklet(ctx: AudioContext): Promise<void> {
    if (loadedContexts.has(ctx)) return;
    const processorSource = typeof source === 'function' ? await source() : source;
    const url = URL.createObjectURL(
      new Blob([processorSource], { type: 'application/javascript' }),
    );
    try {
      await ctx.audioWorklet.addModule(url);
      loadedContexts.add(ctx);
    } finally {
      URL.revokeObjectURL(url);
    }
  };
}
