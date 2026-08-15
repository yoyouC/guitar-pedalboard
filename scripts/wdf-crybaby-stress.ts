/**
 * Crybaby WDF 稳健性压力测试(node scripts/wdf-crybaby-stress.ts)
 * 复现 NaN 污染:
 *   A. 外部注入:输入 NaN/Inf 后切回正常信号,检查输出能否恢复
 *   B. 内部 fuzz:极限幅度/方波/随机信号 × 极端踏板位置,有限输入必须有限输出
 *   C. 长时运行漂移检查
 */
import { CrybabyStage } from '../src/audio/wdf/crybabyStage.dsp.js';

const FS = 48000 * 4;
let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${detail}`);
  if (!ok) failures++;
}

function allFinite(s: CrybabyStage): boolean {
  return (s.nodeVoltages as readonly number[]).every(Number.isFinite);
}

// ---------- A. 外部注入 ----------
console.log('A. 外部注入恢复(有限输出 +  stage 仍存活)');
for (const bad of [NaN, Infinity, -Infinity]) {
  const probe = (badValue: number) => {
    const s = new CrybabyStage(FS);
    s.setPosition(0.5);
    for (let i = 0; i < 1000; i++) s.process(0.1 * Math.sin(i / 20));
    if (badValue !== 0) s.process(badValue); // 注入一个坏样本
    const tail = Math.round(FS * 0.25);
    let sum = 0;
    for (let i = 0; i < 48000; i++) {
      const y = s.process(0.1 * Math.sin(i / 20));
      if (!Number.isFinite(y)) return { finite: false, alive: false };
      if (i >= 48000 - tail) sum += y * y;
    }
    return { finite: true, alive: Math.sqrt(sum / tail) > 0.01 };
  };
  const r = probe(bad);
  check(
    `注入 ${String(bad)}:1s 输出有限且 stage 存活`,
    r.finite && r.alive,
    `finite=${r.finite} alive=${r.alive}`,
  );
}

// ---------- B. 内部极限 fuzz(有限输入 → 必须有限输出) ----------
console.log('B. 内部极限 fuzz');
{
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  const scenarios: { name: string; gen: (i: number) => number; pos: (i: number) => number }[] = [
    { name: '±50V 尖峰', gen: () => (rand() > 0.49 ? 50 : -50), pos: (i) => 0.02 + 0.96 * ((i / 5000) % 1) },
    { name: '±5V 方波 1kHz', gen: (i) => (Math.floor(i / 96) % 2 ? 5 : -5), pos: () => 0.98 },
    { name: '±2V 白噪声', gen: () => 4 * rand(), pos: (i) => 0.02 + 0.96 * Math.abs(Math.sin(i / 3000)) },
    { name: '±10V 低频正弦', gen: (i) => 10 * Math.sin(i / 100), pos: () => 0.02 },
    { name: '±0.5V 吉他 + 位置跳变', gen: (i) => 0.5 * Math.sin(i / 10), pos: (i) => (Math.floor(i / 700) % 2 ? 0.98 : 0.02) },
  ];
  for (const sc of scenarios) {
    const s = new CrybabyStage(FS);
    let bad = -1;
    for (let i = 0; i < 100000; i++) {
      s.setPosition(sc.pos(i));
      const y = s.process(sc.gen(i));
      if (!Number.isFinite(y)) {
        bad = i;
        break;
      }
    }
    check(sc.name, bad < 0 && allFinite(s), bad < 0 ? '10 万样本有限' : `第 ${bad} 样本产生非有限值`);
  }
}

// ---------- C. 长时漂移 ----------
console.log('C. 长时运行(500 万样本混合信号)');
{
  const s = new CrybabyStage(FS);
  let bad = -1;
  let maxAbs = 0;
  for (let i = 0; i < 5_000_000; i++) {
    s.setPosition(0.02 + 0.96 * (0.5 + 0.5 * Math.sin(i / 50000)));
    const x = 0.3 * Math.sin(i / 15) + 0.1 * Math.sin(i / 3.7);
    const y = s.process(x);
    if (!Number.isFinite(y)) {
      bad = i;
      break;
    }
    if (i > 100000) maxAbs = Math.max(maxAbs, Math.abs(y));
  }
  check('无 NaN/Inf', bad < 0, bad < 0 ? '' : `第 ${bad} 样本`);
  check('输出有界(<12V)', maxAbs < 12, `maxAbs=${maxAbs.toFixed(2)}`);
}

console.log(failures ? `\n${failures} 项失败 ✗` : '\n全部通过 ✓');
process.exit(failures ? 1 : 0);
