/**
 * 端到端复现:真实 Web MIDI 路径驱动哇音(CC11 表情流 + 踩钉),观察是否死寂。
 * 单个踏板板页面经 IAC 总线自发自收(与 motion_midi 的发送方式一致):
 * useMidi(IAC input)→ resolveMidiAction → setExpression → handleParam → updateParam。
 *
 * 用法: node scripts/debug-wah-midi-e2e.mjs [wahpedal|crybabywdf] [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EFFECT_ID = process.argv[2] || 'wahpedal';
const TARGET_URL = process.argv[3] || 'http://localhost:5180/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'wah-e2e-chrome-'));
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

// 授权 MIDI(无头 Chrome 默认拒绝;新版 CDP 用 Browser.grantPermissions)
await send('Browser.grantPermissions', {
  origin: new URL(TARGET_URL).origin,
  permissions: ['midi', 'midiSysex'],
});
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: TARGET_URL });
await sleep(4000);

console.log('MIDI 状态:', await evaluate(`
  (() => {
    const el = document.querySelector('.midi-status');
    return el ? el.textContent.trim() : 'midi-status 元素不存在';
  })()`));

console.log('点测试音源:', await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('测试音源'));
    if (!b) return '按钮不存在';
    b.click();
    return 'ok';
  })()`));
await sleep(2000);

console.log('添加哇音(放第一位,让踩钉也能影响它):', await evaluate(`
  (() => {
    const sel = document.querySelector('.add-effect select');
    if (!sel) return '下拉框不存在';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, '${EFFECT_ID}');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return 'added';
  })()`));
await sleep(1500);

// 页面内开 IAC 输出,30Hz 三角波 CC11 + 周期性踩钉(CC20/22),模拟 motion_midi
console.log('启动 IAC 发送:', await evaluate(`
  (async () => {
    const acc = await navigator.requestMIDIAccess({ sysex: false });
    let out = null;
    for (const o of acc.outputs.values()) if (/iac/i.test(o.name ?? '')) out = o;
    if (!out) return '找不到 IAC 输出(音频 MIDI 设置里 IAC 需在线)';
    let pos = 50, dir = 1, tick = 0;
    window.__e2eIv = setInterval(() => {
      tick++;
      pos += dir * 3;
      if (pos >= 100) { pos = 100; dir = -1; }
      if (pos <= 0) { pos = 0; dir = 1; }
      out.send([0xb0, 11, Math.round(pos * 127 / 100)]);
      // 每 3 秒一次踩钉 1(CC20 toggle 交替 127/0),每 5 秒一次踩钉 3(CC22 脉冲)
      if (tick % 90 === 0) out.send([0xb0, 20, (tick / 90) % 2 ? 127 : 0]);
      if (tick % 150 === 0) { out.send([0xb0, 22, 127]); setTimeout(() => out.send([0xb0, 22, 0]), 120); }
    }, 33);
    return 'sending on ' + out.name;
  })()`, true));
await sleep(1000);

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
    // 找哇音 uid:DOM 里哇音单块的百分比读数 + 引擎侧最后一个模块表
    const treadle = document.querySelector('.wah-value');
    const keys = [...e.moduleAnalysers.keys()];
    const uid = keys[keys.length - 1];
    return {
      treadle: treadle ? treadle.textContent : '?',
      wah: m(e.moduleAnalysers.get(uid)),
      output: m(e.outputAnalyser),
      modules: keys.length,
    };
  })()`;

let deadSince = -1;
for (let sec = 1; sec <= 120; sec++) {
  await sleep(1000);
  const r = await evaluate(sample);
  const dead = r.wah && r.wah.rms < 1e-5;
  console.log(
    `t=${String(sec).padStart(3)}s treadle=${r.treadle} wah.rms=${r.wah?.rms} out.rms=${r.output?.rms} nonFinite=${r.wah?.nonFinite ?? '-'}${dead ? '  ← 死寂' : ''}`,
  );
  if (dead) {
    if (deadSince < 0) deadSince = sec;
    if (sec - deadSince >= 5) {
      console.log(`✗ 复现:连续 5s 无输出(从 t=${deadSince}s 起)`);
      break;
    }
  } else deadSince = -1;
}
if (deadSince < 0) console.log('✓ 120s 端到端未复现死寂');
const logs = consoleLogs.filter((l) => !l.includes('Download the React DevTools') && !l.includes('[vite]'));
if (logs.length) console.log('页面 console:', logs.slice(0, 10));
cleanup(0);
