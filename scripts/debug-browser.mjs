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

console.log('== 步骤 1: 点击 测试音源(默认 Fender Clean → fender-twinverb)==');
console.log(await evaluate(clickButton('测试音源')));
await sleep(2500);
console.log(JSON.stringify(await evaluate(sampleLevels), null, 2));

console.log('\n== 步骤 2: 点击 NAM 箱头(分类:Marshall Crunch → jcm2000-crunch)==');
console.log(await evaluate(clickButton('Marshall Crunch')));
await sleep(2500);
console.log(JSON.stringify(await evaluate(sampleLevels), null, 2));

console.log('\n== 步骤 3: 再点一次 Marshall Crunch(型号记忆应保持)==');
console.log(await evaluate(clickButton('Marshall Crunch')));
await sleep(1500);
console.log(JSON.stringify(await evaluate(sampleLevels), null, 2));

console.log('\n== 步骤 4: 最小复现(独立小图,nam-lstm vs noise-gate 对照)==');
const minimalRepro = `(async () => {
  const e = window.__audioEngine;
  const ctx = e.ctx;
  const modelJson = await (await fetch('/models/lstm-demo.nam')).text();
  const wasmBytes = await (await fetch('/nam-wasm/nam-wasm-glue.wasm')).arrayBuffer();
  const rmsOf = (an) => {
    const b = new Float32Array(an.fftSize); an.getFloatTimeDomainData(b);
    let s = 0; for (const v of b) s += v * v;
    return +(20 * Math.log10(Math.sqrt(s / b.length) + 1e-12)).toFixed(1);
  };

  // 简单对照:osc → g → node → an
  const mk = async (name, withModel) => {
    const osc = ctx.createOscillator(); osc.frequency.value = 440;
    const g = ctx.createGain(); g.gain.value = 0.5;
    const node = new AudioWorkletNode(ctx, name);
    const an = ctx.createAnalyser(); an.fftSize = 2048;
    const mute = ctx.createGain(); mute.gain.value = 0;
    osc.connect(g); g.connect(node); node.connect(an); an.connect(mute); mute.connect(ctx.destination);
    if (withModel) {
      const ready = new Promise((res) => {
        node.port.addEventListener('message', function h(e) {
          if (e.data?.type === 'stage-ready') { node.port.removeEventListener('message', h); res(); }
        });
      });
      node.port.start?.();
      const copy = wasmBytes.slice(0);
      node.port.postMessage({ type: 'prepare', wasmBytes: copy }, [copy]);
      node.port.postMessage({ type: 'stage-load', idx: 0, json: modelJson, activate: true });
      await ready;
    }
    osc.start();
    await new Promise(r => setTimeout(r, 800));
    const rms = rmsOf(an);
    osc.stop(); [osc, g, node, an, mute].forEach(n => n.disconnect());
    return rms;
  };

  const ng = await mk('noise-gate', false);
  const namNoModel = await mk('nam-wasm', false);
  const nam = await mk('nam-wasm', true);
  return JSON.stringify({ noiseGateRmsDb: ng, namPassthroughRmsDb: namNoModel, namModelRmsDb: nam });
})()`;
console.log(await evaluate(minimalRepro, true));

console.log('链条输出:', JSON.stringify((await evaluate(sampleLevels)).output));

console.log('\n== 步骤 9: 切换内置模型(High Gain → 5150)==');
console.log(await evaluate(clickButton('High Gain')));
await sleep(1500);
const switchJcm = `(() => {
  const sel = document.querySelector('.nam-model-select');
  if (!sel) return '模型下拉框不存在';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, '5150-blockletter');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return 'switched to 5150-blockletter';
})()`;
console.log(await evaluate(switchJcm));
await sleep(3000);
console.log(JSON.stringify((await evaluate(sampleLevels)).amp));

console.log('\n== 步骤 11: 箱头分类 UI(分类 tab + 类内型号)==');
const setModel = (key) => `(() => {
  const sel = document.querySelector('.nam-model-select');
  if (!sel) return '型号下拉不存在';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, '${key}');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return 'model → ${key}';
})()`;
// Fender Clean → fender-twinverb(NAM WASM)
console.log(await evaluate(clickButton('Fender Clean')));
await sleep(1200);
console.log(await evaluate(setModel('nam-wasm:fender-twinverb')));
await sleep(2500);
console.log('twinverb amp:', JSON.stringify((await evaluate(sampleLevels)).amp));
// Marshall Crunch → 类内记住的型号(默认 JCM2000 Crunch NAM)
console.log(await evaluate(clickButton('Marshall Crunch')));
await sleep(1200);
console.log('crunch 类默认型号 amp:', JSON.stringify((await evaluate(sampleLevels)).amp));
// High Gain → 5150
console.log(await evaluate(clickButton('High Gain')));
await sleep(1200);
console.log(await evaluate(setModel('nam-wasm:5150-blockletter')));
await sleep(2500);
console.log('5150 amp:', JSON.stringify((await evaluate(sampleLevels)).amp));

console.log('\n== 步骤 12: 增益扫档包(JCM800 sweep:预载 + GAIN 切档)==');
console.log(await evaluate(clickButton('Marshall Crunch')));
await sleep(1200);
console.log(await evaluate(`(() => {
  const sel = document.querySelector('.nam-model-select');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, 'nam-wasm-pack:jcm800-sweep');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return 'model → jcm800-sweep(预载开始,约 3-4s)';
})()`));
await sleep(6000); // 8 档预载
const ampNow = async () => (await evaluate(sampleLevels)).amp.rmsDb;
console.log('预载后(默认档) amp:', await ampNow());
// GAIN 拧到 0(g1.0)与 100(g10)分别测电平
for (const g of [0, 30, 70, 100]) {
  console.log(await evaluate(`(() => {
    window.__audioEngine.updateAmpParam('gain', ${g});
    return 'GAIN → ${g}';
  })()`));
  await sleep(600);
  console.log('  amp:', await ampNow());
}
// 面板档位标签
console.log(await evaluate(`document.querySelector('.nam-stage-label')?.textContent ?? '无档位标签'`));

console.log('\n== 步骤 12b: 新扫档包(Recto Red + Bassman)==');
console.log(await evaluate(clickButton('High Gain')));
await sleep(1200);
console.log(await evaluate(`(() => {
  const sel = document.querySelector('.nam-model-select');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, 'nam-wasm-pack:recto-red-sweep');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return 'model → recto-red-sweep';
})()`));
await sleep(5000);
console.log('recto-red 默认档 amp:', JSON.stringify((await evaluate(sampleLevels)).amp));
console.log(await evaluate(`(() => { window.__audioEngine.updateAmpParam('gain', 100); return 'GAIN → 100 (g10)'; })()`));
await sleep(600);
console.log('g10 amp:', JSON.stringify((await evaluate(sampleLevels)).amp));
console.log(await evaluate(clickButton('Fender Clean')));
await sleep(1200);
console.log(await evaluate(`(() => {
  const sel = document.querySelector('.nam-model-select');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, 'nam-wasm-pack:bassman-sweep');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return 'model → bassman-sweep';
})()`));
await sleep(5000);
console.log('bassman 默认档 amp:', JSON.stringify((await evaluate(sampleLevels)).amp));

console.log('\n== 步骤 13: 加载进度条 ==');
console.log(await evaluate(clickButton('Marshall Crunch')));
await sleep(1200);
console.log(await evaluate(`(() => {
  const sel = document.querySelector('.nam-model-select');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, 'nam-wasm-pack:jcm800-sweep');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return 'model → jcm800-sweep';
})()`));
await sleep(1500);
for (let i = 0; i < 8; i++) {
  const t = await evaluate(`(() => {
    const bar = document.querySelector('.amp-loadbar');
    if (!bar) return '无';
    const label = bar.querySelector('.amp-loadbar-label')?.textContent ?? '';
    const width = bar.querySelector('.amp-loadbar-fill')?.style.width ?? '';
    return '"' + label + '" ' + width;
  })()`);
  console.log(`  t+${((i + 1) * 0.4).toFixed(1)}s: ${t}`);
  if (t === '无' && i > 2) break;
  await sleep(400);
}
await sleep(3000);
console.log('加载完成后:', await evaluate(`document.querySelector('.amp-loadbar') ? '仍存在(应消失!)' : '已消失 ✓'`));

console.log('\n== 步骤 14: 换单块/切 bypass 不重载箱头(实例复用)==');
console.log(await evaluate(clickButton('Marshall Crunch')));
await sleep(1200);
console.log(await evaluate(`(() => {
  const sel = document.querySelector('.nam-model-select');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, 'nam-wasm-pack:jcm800-sweep');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return 'model → jcm800-sweep';
})()`));
await sleep(6000);
const countPreloadLogs = () => consoleLogs.filter((l) => l.includes('扫档预载')).length;
const preloadAfterLoad = countPreloadLogs();
console.log('预载完成,预载日志数:', preloadAfterLoad);
// 加一个 overdrive 单块(结构变化)
console.log(await evaluate(`(() => {
  const sel = document.querySelector('.add-effect select');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, 'overdrive');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return 'added overdrive';
})()`));
await sleep(1500);
console.log('加单块后预载日志数:', countPreloadLogs(), '(应不变)');
console.log('加单块后进度条存在?', await evaluate(`!!document.querySelector('.amp-loadbar')`), '(应 false)');
console.log('加单块后箱头电平:', JSON.stringify((await evaluate(sampleLevels)).amp));
// bypass 切两次
console.log(await evaluate(clickButton('Bypass')));
await sleep(600);
console.log(await evaluate(clickButton('已 Bypass')));
await sleep(1000);
console.log('bypass 往返后预载日志数:', countPreloadLogs(), '(应不变)');
console.log('bypass 往返后箱头电平:', JSON.stringify((await evaluate(sampleLevels)).amp));
console.log('预载日志终值:', countPreloadLogs(), '/ 初始:', preloadAfterLoad);

console.log('\n== 页面 console 输出 ==');
for (const l of consoleLogs) console.log(l);

cleanup(0);
