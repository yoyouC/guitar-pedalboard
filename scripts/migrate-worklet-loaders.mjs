/**
 * 一次性 codemod:把 24 个相同的 worklet 加载尾巴换成 createWorkletLoader。
 * 只替换与规范形状逐字节匹配的文件;不匹配则跳过并报告。
 * 用法:node scripts/migrate-worklet-loaders.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILES = [
  'src/audio/noiseGateWorklet.ts',
  'src/audio/wahWorklet.ts',
  'src/audio/whammyWorklet.ts',
  ...[
    'analogdelay', 'bigmuff', 'crybaby', 'ds1',
    'dynacomp', 'fet1176', 'fuzzface', 'klon', 'la2a', 'pingpong',
    'plate', 'rat', 'shimmer', 'springreverb', 'tapedelay', 'ts808',
  ].map((n) => `src/audio/wdf/${n}Worklet.ts`),
];

const TAIL_RE =
  /let loaded = false;\n\n\/\*\* 幂等加载,使用前必须先 await \*\/\nexport async function (\w+)\(ctx: AudioContext\): Promise<void> \{\n  if \(loaded\) return;\n  const url = URL\.createObjectURL\(\n    new Blob\(\[processorSource\], \{ type: 'application\/javascript' \}\),\n  \);\n  try \{\n    await ctx\.audioWorklet\.addModule\(url\);\n    loaded = true;\n  \} finally \{\n    URL\.revokeObjectURL\(url\);\n  \}\n\}\n?$/;

let migrated = 0;
for (const path of FILES) {
  const text = readFileSync(path, 'utf8');
  const m = text.match(TAIL_RE);
  if (!m) {
    console.error(`SKIP(尾部不匹配): ${path}`);
    continue;
  }
  const rel = path.includes('/wdf/') ? '../workletLoader' : './workletLoader';
  const replacement =
    `/** 幂等加载(按 AudioContext 注册),使用前必须先 await */\n` +
    `export const ${m[1]} = createWorkletLoader(processorSource);\n`;
  let next = text.slice(0, m.index) + replacement;
  // 在文件头部注释之后插入 import(放在首个非注释行前)
  next = next.replace(
    /^((?:\/\*\*[\s\S]*?\*\/\n|\/\/[^\n]*\n|\n)*)/,
    `$1import { createWorkletLoader } from '${rel}';\n\n`,
  );
  writeFileSync(path, next);
  migrated++;
  console.log(`OK ${path} -> ${m[1]}`);
}
console.log(`migrated ${migrated}/${FILES.length}`);
