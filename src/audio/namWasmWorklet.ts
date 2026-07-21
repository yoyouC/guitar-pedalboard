import processorSource from './namWasmProcessor.js?raw';

const GLUE_URL = `${import.meta.env.BASE_URL}nam-wasm/nam-wasm-glue.js`;

let loaded = false;

/**
 * 幂等加载 NAM WASM worklet,使用前必须先 await。
 * worklet 作用域没有 importScripts,因此把 emscripten glue 与处理器
 * 拼成一个 Blob 脚本一次性 addModule(glue 定义的 NamWasmModule 工厂
 * 与处理器同处一个全局作用域)。
 */
export async function loadNamWasmWorklet(ctx: AudioContext): Promise<void> {
  if (loaded) return;
  const glue = await fetch(GLUE_URL).then((r) => {
    if (!r.ok) throw new Error(`glue 下载失败 HTTP ${r.status}`);
    return r.text();
  });
  // emscripten worker 版 glue 的兼容垫片(worklet 作用域无 self/location)
  const shim = `if (typeof self === 'undefined') globalThis.self = globalThis;
if (typeof location === 'undefined') globalThis.location = { href: '' };
`;
  const url = URL.createObjectURL(
    new Blob([shim + glue + '\n' + processorSource], { type: 'application/javascript' }),
  );
  try {
    await ctx.audioWorklet.addModule(url);
    loaded = true;
  } finally {
    URL.revokeObjectURL(url);
  }
}
