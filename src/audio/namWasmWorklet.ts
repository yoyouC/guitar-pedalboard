import processorSource from './namWasmProcessor.js?raw';
import { BASE_URL } from './baseUrl';
import { createWorkletLoader } from './workletLoader';

const GLUE_URL = `${BASE_URL}nam-wasm/nam-wasm-glue.js`;

/**
 * 每次注册前现取处理器源码:worklet 作用域没有 importScripts,
 * 因此把 emscripten glue 与处理器拼成一个脚本一次性 addModule
 * (glue 定义的 NamWasmModule 工厂与处理器同处一个全局作用域)。
 */
async function buildProcessorSource(): Promise<string> {
  const glue = await fetch(GLUE_URL).then((r) => {
    if (!r.ok) throw new Error(`glue 下载失败 HTTP ${r.status}`);
    return r.text();
  });
  // emscripten worker 版 glue 的兼容垫片(worklet 作用域无 self/location)
  const shim = `if (typeof self === 'undefined') globalThis.self = globalThis;
if (typeof location === 'undefined') globalThis.location = { href: '' };
`;
  return shim + glue + '\n' + processorSource;
}

/** 幂等加载 NAM WASM worklet(按 AudioContext 注册),使用前必须先 await */
export const loadNamWasmWorklet = createWorkletLoader(buildProcessorSource);
