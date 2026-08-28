#!/usr/bin/env node
/**
 * 发布产物检查(Vercel buildCommand 的一部分):
 *   1. dist/ 中不得出现 models-local 内容(许可不允许公开分发的文件);
 *   2. dist/ 中不得出现扫档包文件名(*-sweep/ 目录);
 *   3. public/models/ 下每个 .nam 文件都必须在 ATTRIBUTION.md 中有许可记录;
 *   4. dist 必须包含 wasm 与至少一个模型文件。
 * 任一失败即非零退出,阻断部署。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

let failures = 0;
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  failures++;
};
const ok = (msg) => console.log(`✓ ${msg}`);

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

if (!existsSync('dist')) fail('dist/ 不存在,先运行 npm run build');

// 1+2. 违禁内容:仅 models-local/(预留的本地评估目录)不得出现
const forbidden = [/models-local\//];
let distFiles = [];
if (existsSync('dist')) distFiles = [...walk('dist')];
const hits = distFiles.filter((f) => forbidden.some((re) => re.test(f)));
if (hits.length) {
  for (const f of hits.slice(0, 10)) fail(`dist 含本地评估模型: ${f}`);
} else {
  ok('dist 无 models-local 内容');
}

// 3. public/models 许可覆盖:按文件名或其父目录(目录级条目)匹配
const attribution = existsSync('public/models/ATTRIBUTION.md')
  ? readFileSync('public/models/ATTRIBUTION.md', 'utf8')
  : '';
const namFiles = existsSync('public/models')
  ? [...walk('public/models')].filter((f) => f.endsWith('.nam'))
  : [];
const covered = (f) => {
  const parts = f.split('/');
  const base = parts[parts.length - 1];
  const dir = parts[parts.length - 2] ?? '';
  return attribution.includes(base) || (dir.length >= 3 && dir !== 'models' && attribution.includes(dir));
};
for (const f of namFiles) {
  if (!covered(f)) fail(`public/models 中 ${f} 未在 ATTRIBUTION.md 记录许可`);
}
ok(`public/models 共 ${namFiles.length} 个 .nam,许可记录检查完毕`);

// 4. 必备产物
if (!distFiles.some((f) => f.endsWith('.wasm'))) fail('dist 缺少 .wasm 产物');
if (!distFiles.some((f) => f.endsWith('.nam'))) fail('dist 缺少 .nam 模型');
if (failures === 0) ok('wasm 与模型产物齐全');

// 5. Cab IR manifest / attribution / binary integrity. approved=false 可以保留研究占位，
// 但不得偷偷分发 WAV；一旦批准则字段、源码归属、public 与 dist hash 必须全部闭环。
const irManifestPath = 'public/irs/manifest.json';
const irAttributionPath = 'public/irs/ATTRIBUTION.md';
if (!existsSync(irManifestPath)) {
  fail('缺少 public/irs/manifest.json');
} else {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(irManifestPath, 'utf8'));
  } catch {
    fail('public/irs/manifest.json 不是有效 JSON');
  }
  const requiredIds = ['open1x12', 'blue2x12', 'gb4x12', 'v304x12'];
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  const attributionText = existsSync(irAttributionPath) ? readFileSync(irAttributionPath, 'utf8') : '';
  if (!attributionText) fail('缺少 public/irs/ATTRIBUTION.md');
  for (const id of requiredIds) {
    const entry = entries.find((candidate) => candidate?.id === id);
    if (!entry) {
      fail(`IR manifest 缺少 ${id}`);
      continue;
    }
    for (const field of ['sampleRate', 'bitsPerSample', 'durationSeconds', 'trimmedFrames', 'calibrationDb']) {
      if (!Number.isFinite(entry[field])) fail(`${id} 缺少 ${field}`);
    }
    if (entry.channels !== 1 && entry.channels !== 2) fail(`${id} channels 必须为 1 或 2`);
    const publicPath = typeof entry.file === 'string' ? join('public/irs', entry.file) : '';
    const distPath = typeof entry.file === 'string' ? join('dist/irs', entry.file) : '';
    if (!entry.approved) {
      if (publicPath && existsSync(publicPath)) fail(`${id} 未批准却已加入 public WAV`);
      continue;
    }
    for (const field of ['file', 'url', 'sha256', 'sourceUrl', 'license', 'attribution', 'captureDescription']) {
      if (typeof entry[field] !== 'string' || !entry[field].trim()) fail(`${id} 缺少 ${field}`);
    }
    if (!attributionText.includes(id)) fail(`ATTRIBUTION.md 未记录 ${id}`);
    if (!publicPath || !existsSync(publicPath)) {
      fail(`${id} 已批准但 public WAV 不存在`);
      continue;
    }
    const digest = createHash('sha256').update(readFileSync(publicPath)).digest('hex');
    if (digest !== entry.sha256) fail(`${id} public WAV SHA-256 与 manifest 不符`);
    if (!entry.file.includes(digest.slice(0, 8))) fail(`${id} 文件名缺少 SHA-256 指纹`);
    if (entry.url !== `/irs/${entry.file}`) fail(`${id} url 与 fingerprinted file 不一致`);
    if (!existsSync(distPath)) fail(`${id} 未进入 dist/irs`);
    else {
      const distDigest = createHash('sha256').update(readFileSync(distPath)).digest('hex');
      if (distDigest !== entry.sha256) fail(`${id} dist WAV SHA-256 与 manifest 不符`);
    }
  }
  const listed = new Set(entries.map((entry) => entry?.file).filter(Boolean));
  const publicWavs = [...walk('public/irs')].filter((file) => /\.wav$/i.test(file));
  for (const file of publicWavs) {
    const name = file.split('/').at(-1);
    if (!listed.has(name)) fail(`public/irs 中存在未登记 WAV: ${name}`);
  }
  if (entries.length === requiredIds.length) ok('Cab IR manifest 与发布许可门禁检查完毕');
}

if (failures > 0) {
  console.error(`\n发布检查失败(${failures} 项)。`);
  process.exit(1);
}
console.log('\n发布检查通过。');
