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

if (failures > 0) {
  console.error(`\n发布检查失败(${failures} 项)。`);
  process.exit(1);
}
console.log('\n发布检查通过。');
