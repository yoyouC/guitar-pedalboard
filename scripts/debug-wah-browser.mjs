/**
 * CDP 浏览器复现:哇音在 motion_midi 式连续扫 position 下是否死寂。
 * 打开踏板板 → 点测试音源 → 添加指定哇音 → 页面内 30Hz 三角波扫 position
 * (模拟表情踏板 CC 流),每秒采样该模块与总输出 RMS,观察是否归零。
 *
 * 用法: node scripts/debug-wah-browser.mjs [wahpedal|crybabywdf] [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EFFECT_ID = process.argv[2] || 'wahpedal';
const TARGET_URL = process.argv[3] || 'http://localhost:5180/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'wah-debug-chrome-'));
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
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const consoleLogs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'Runtime.consoleAPICalled') {
    consoleLogs.push(`[${m.params.type}] ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
  } else if (m.method === 'Runtime.exceptionThrown') {
    consoleLogs.push(`[EXCEPTION] ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: TARGET_URL });
await sleep(3500);

console.log('点测试音源:', await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('测试音源'));
    if (!b) return '按钮不存在';
    b.click();
    return 'ok';
  })()`));
await sleep(2000);

console.log('添加哇音:', await evaluate(`
  (() => {
    const sel = document.querySelector('.add-effect select');
    if (!sel) return '下拉框不存在';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, '${EFFECT_ID}');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return 'added ${EFFECT_ID}';
  })()`));
await sleep(1500);

// 找到刚加的哇音 uid(最后一个 moduleAnalysers key 不可靠,用引擎链查询)
const wahUid = await evaluate(`
  (() => {
    const e = window.__audioEngine;
    if (!e) return null;
    // moduleAnalysers 的 key 即 uid;取最后一个(刚添加的)
    const keys = [...e.moduleAnalysers.keys()];
    return keys[keys.length - 1];
  })()`);
if (!wahUid) { console.log('找不到哇音 uid'); cleanup(1); }
console.log('哇音 uid:', wahUid);

// 页面内 30Hz 三角波扫 position(0↔100,约 1.1s 一个全行程,比真人踩更激进)
await evaluate(`
  (() => {
    const e = window.__audioEngine;
    let pos = 50, dir = 1;
    window.__wahSweepIv = setInterval(() => {
      pos += dir * 3;
      if (pos >= 100) { pos = 100; dir = -1; }
      if (pos <= 0) { pos = 0; dir = 1; }
      e.updateParam('${wahUid}', 'position', pos);
    }, 33);
    return 'sweeping';
  })()`);

const sample = `
  (() => {
    const e = window.__audioEngine;
    const m = (a) => {
      if (!a) return null;
      const b = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(b);
      let s = 0, bad = 0;
      for (const v of b) { s += v * v; if (!Number.isFinite(v)) bad++; }
      return { rms: +(Math.sqrt(s / b.length)).toFixed(5), nonFinite: bad };
    };
    return { wah: m(e.moduleAnalysers.get('${wahUid}')), output: m(e.outputAnalyser), ctxState: e.ctx.state };
  })()`;

let deadSince = -1;
for (let sec = 1; sec <= 45; sec++) {
  await sleep(1000);
  const r = await evaluate(sample);
  const tag = r.wah && r.wah.rms < 1e-5 ? '  ← 模块死寂' : '';
  console.log(`t=${String(sec).padStart(2)}s wah.rms=${r.wah?.rms} out.rms=${r.output?.rms} nonFinite=${r.wah?.nonFinite ?? '-'}${tag}`);
  if (r.wah && r.wah.rms < 1e-5) {
    if (deadSince < 0) deadSince = sec;
    if (sec - deadSince >= 5) {
      console.log(`✗ 复现:哇音连续 5s 无输出(从 t=${deadSince}s 起)`);
      break;
    }
  } else {
    deadSince = -1;
  }
}
if (deadSince < 0) console.log('✓ 45s 连续扫频未复现死寂');
const logs = consoleLogs.filter((l) => !l.includes('Download the React DevTools'));
if (logs.length) console.log('页面 console:', logs.slice(0, 10));
cleanup(0);
