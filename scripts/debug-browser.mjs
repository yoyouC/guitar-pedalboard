/**
 * CDP 浏览器直连调试:启动独立 Chrome(headless,独立 profile),打开 dev server,
 * 依次点击"测试音源"与"NAM Capture"箱头,经 window.__audioEngine 采样
 * input/amp/cab/output 各级 analyser 的 RMS/peak,并收集页面 console 输出。
 *
 * 用法: node scripts/debug-browser.mjs [url]   (默认 http://localhost:5174/)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TARGET_URL = process.argv[2] || 'http://localhost:5174/';
const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].find(existsSync);
if (!CHROME) throw new Error('未找到 Chrome/Chromium/Edge');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 启动 Chrome(port=0,从 DevToolsActivePort 读实际端口)----------
const profile = mkdtempSync(join(tmpdir(), 'nam-debug-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--user-data-dir=${profile}`,
  '--remote-debugging-port=0',
  '--no-first-run',
  '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  'about:blank',
], { stdio: 'ignore' });

const cleanup = (code) => {
  chrome.kill('SIGKILL');
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(code);
};
process.on('SIGINT', () => cleanup(130));

// ---------- 等待 DevTools 端口 ----------
async function devtoolsPort() {
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100; i++) {
    if (existsSync(portFile)) {
      const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
      if (port > 0) return port;
    }
    await sleep(200);
  }
  throw new Error('Chrome DevTools 端口未就绪');
}

const port = await devtoolsPort();
let targets;
for (let i = 0; i < 25; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    if (targets.some((t) => t.type === 'page')) break;
  } catch {}
  await sleep(200);
}
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('未找到 page target');

// ---------- 最小 CDP 客户端 ----------
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
const pending = new Map();
const consoleLogs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    consoleLogs.push(`[${m.params.type}] ${text}`);
  } else if (m.method === 'Runtime.exceptionThrown') {
    consoleLogs.push(`[EXCEPTION] ${m.params.exceptionDetails.text} ${m.params.exceptionDetails.exception?.description ?? ''}`);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(`页面内执行失败: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
  return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: TARGET_URL });
await sleep(3500);

const clickButton = (text) => `
  (() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('${text}'));
    if (!b) return '按钮不存在: ${text}';
    b.click();
    return 'clicked ${text}';
  })()`;

const sampleLevels = `(() => {
  const e = window.__audioEngine;
  if (!e) return 'window.__audioEngine 不存在(需 dev 模式)';
  if (!e.ctx) return 'AudioContext 未创建';
  const m = (a) => {
    if (!a) return null;
    const b = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(b);
    let s = 0, p = 0;
    for (const v of b) { s += v * v; p = Math.max(p, Math.abs(v)); }
    return { rmsDb: +(20 * Math.log10(Math.sqrt(s / b.length) + 1e-12)).toFixed(1),
             peakDb: +(20 * Math.log10(p + 1e-12)).toFixed(1) };
  };
  const modules = {};
  for (const [uid, a] of e.moduleAnalysers.entries()) modules[uid.slice(0, 8)] = m(a);
  return { state: e.ctx.state, sampleRate: e.ctx.sampleRate,
           input: m(e.inputAnalyser), modules,
           amp: m(e.ampAnalyser), cab: m(e.cabAnalyser), output: m(e.outputAnalyser) };
})()`;

console.log('== 步骤 1: 点击 测试音源(默认 crunch 箱头)==');
console.log(await evaluate(clickButton('测试音源')));
await sleep(2500);
console.log(JSON.stringify(await evaluate(sampleLevels), null, 2));

console.log('\n== 步骤 2: 点击 NAM Capture 箱头 ==');
console.log(await evaluate(clickButton('NAM Capture')));
await sleep(2500);
console.log(JSON.stringify(await evaluate(sampleLevels), null, 2));

console.log('\n== 步骤 3: 再切回 crunch 对比 ==');
console.log(await evaluate(clickButton('British Crunch')));
await sleep(1500);
console.log(JSON.stringify(await evaluate(sampleLevels), null, 2));

console.log('\n== 步骤 4: 最小复现(独立小图,nam-lstm vs noise-gate 对照)==');
const minimalRepro = `(async () => {
  const e = window.__audioEngine;
  const ctx = e.ctx;
  const model = await (await fetch('/models/lstm-demo.nam')).json();
  const rmsOf = (an) => {
    const b = new Float32Array(an.fftSize); an.getFloatTimeDomainData(b);
    let s = 0; for (const v of b) s += v * v;
    return +(20 * Math.log10(Math.sqrt(s / b.length) + 1e-12)).toFixed(1);
  };
  const modelMsg = { type: 'model', inputSize: model.config.input_size,
    hiddenSize: model.config.hidden_size, numLayers: model.config.num_layers,
    weights: new Float32Array(model.weights) };

  // 简单对照:osc → g → node → an
  const mk = async (name, withModel) => {
    const osc = ctx.createOscillator(); osc.frequency.value = 440;
    const g = ctx.createGain(); g.gain.value = 0.5;
    const node = new AudioWorkletNode(ctx, name);
    const an = ctx.createAnalyser(); an.fftSize = 2048;
    const mute = ctx.createGain(); mute.gain.value = 0;
    osc.connect(g); g.connect(node); node.connect(an); an.connect(mute); mute.connect(ctx.destination);
    if (withModel) node.port.postMessage({ ...modelMsg, weights: new Float32Array(model.weights) });
    osc.start();
    await new Promise(r => setTimeout(r, 800));
    const rms = rmsOf(an);
    osc.stop(); [osc, g, node, an, mute].forEach(n => n.disconnect());
    return rms;
  };

  // 精确复刻 createNamAmp 拓扑与接线顺序:内部先接线,上游 osc 最后接
  const exact = async (upstreamLast) => {
    const input = ctx.createGain();
    const drive = ctx.createGain();
    const node = new AudioWorkletNode(ctx, 'nam-lstm');
    const norm = ctx.createGain();
    const master = ctx.createGain(); master.gain.value = 0.55;
    const output = ctx.createGain();
    const an = ctx.createAnalyser(); an.fftSize = 2048;
    const mute = ctx.createGain(); mute.gain.value = 0;
    const osc = ctx.createOscillator(); osc.frequency.value = 440;
    const og = ctx.createGain(); og.gain.value = 0.5;
    if (!upstreamLast) { osc.connect(og); og.connect(input); }
    input.connect(drive);
    drive.connect(node);
    node.connect(norm);
    norm.connect(master);
    master.connect(output);
    output.connect(an);
    an.connect(mute);
    mute.connect(ctx.destination);
    if (upstreamLast) { osc.connect(og); og.connect(input); } // 引擎顺序:prev 最后接
    node.port.postMessage({ ...modelMsg, weights: new Float32Array(model.weights) });
    osc.start();
    await new Promise(r => setTimeout(r, 800));
    const rms = rmsOf(an);
    osc.stop(); [osc, og, input, drive, node, norm, master, output, an, mute].forEach(n => n.disconnect());
    return rms;
  };

  const ng = await mk('noise-gate', false);
  const namNoModel = await mk('nam-lstm', false);
  const nam = await mk('nam-lstm', true);
  const exactFirst = await exact(false);
  const exactLast = await exact(true);
  return JSON.stringify({ noiseGateRmsDb: ng, namPassthroughRmsDb: namNoModel, namModelRmsDb: nam,
    exactTopoUpstreamFirstRmsDb: exactFirst, exactTopoUpstreamLastRmsDb: exactLast });
})()`;
console.log(await evaluate(minimalRepro, true));

console.log('\n== 步骤 5: 切回 NAM 并切换内置模型(Boss LSTM 1×16)==');
console.log(await evaluate(clickButton('NAM Capture')));
await sleep(1500);
const switchModel = `(() => {
  const sel = document.querySelector('.nam-model-select');
  if (!sel) return '模型下拉框不存在';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, 'boss-1x16');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return 'switched';
})()`;
console.log(await evaluate(switchModel));
await sleep(2000);
console.log(JSON.stringify(await evaluate(sampleLevels), null, 2));

console.log('\n== 步骤 6: NAM WaveNet(WASM)箱头 ==');
console.log(await evaluate(clickButton('NAM WaveNet')));
await sleep(5000); // wasm 初始化 + 模型加载
console.log(JSON.stringify(await evaluate(sampleLevels), null, 2));

console.log('\n== 步骤 7: 重建风暴(12 轮 NAM WaveNet ↔ Crunch)+ Chrome CPU 采样 ==');
// 基线:风暴前采一次
const { execSync } = await import('node:child_process');
const chromeCpu = () => {
  try {
    const out = execSync(`ps -A -o %cpu,command | grep '${profile}' | grep -v grep`, { encoding: 'utf8' });
    return out.trim().split('\n').reduce((s, l) => s + parseFloat(l.trim().split(/\s+/)[0] || 0), 0).toFixed(1);
  } catch { return 'n/a'; }
};
console.log('风暴前 Chrome 总 CPU%:', chromeCpu());
for (let i = 0; i < 12; i++) {
  await evaluate(clickButton('British Crunch'));
  await sleep(200);
  await evaluate(clickButton('NAM WaveNet'));
  await sleep(200);
}
await sleep(2000);
console.log('风暴后(12 轮重建)Chrome 总 CPU%:', chromeCpu());
console.log('风暴后电平(验证仍在正常工作):');
console.log(JSON.stringify(await evaluate(sampleLevels), null, 2));

console.log('\n== 步骤 8: NAM 单块(NAMKnobs TS808)——添加 + 旋钮条件化 ==');
const addNamTs = `(() => {
  const sel = document.querySelector('.add-effect select');
  if (!sel) return '添加菜单不存在';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, 'namTs');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return 'added namTs';
})()`;
console.log(await evaluate(addNamTs));
await sleep(4000); // wasm 初始化 + 模型加载
const sampleModule = (label) => `(() => {
  const e = window.__audioEngine;
  const uids = [...e.moduleAnalysers.keys()];
  const uid = uids[uids.length - 1];
  const a = e.moduleAnalysers.get(uid);
  const b = new Float32Array(a.fftSize); a.getFloatTimeDomainData(b);
  let s = 0; for (const v of b) s += v * v;
  return '${label} uid=' + uid.slice(0, 8) + ' rmsDb=' + (20 * Math.log10(Math.sqrt(s / b.length) + 1e-12)).toFixed(1);
})()`;
console.log(await evaluate(sampleModule('drive=0.5')));
console.log(await evaluate(`(() => {
  const e = window.__audioEngine;
  const uids = [...e.moduleAnalysers.keys()];
  e.updateParam(uids[uids.length - 1], 'drive', 1.0);
  return 'drive → 1.0';
})()`));
await sleep(800);
console.log(await evaluate(sampleModule('drive=1.0')));
console.log('链条输出:', JSON.stringify((await evaluate(sampleLevels)).output));

console.log('\n== 页面 console 输出 ==');
for (const l of consoleLogs) console.log(l);

cleanup(0);
