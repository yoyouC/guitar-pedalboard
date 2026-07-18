/**
 * 用 Karplus-Strong 拨弦合成渲染一段清音电吉他 riff → 16bit 立体声 WAV。
 * 用法:node scripts/render-guitar-riff.mjs
 * 输出:public/samples/guitar-riff.wav
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SR = 44100;
const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../public/samples/guitar-riff.wav',
);

/**
 * Karplus-Strong 拨弦单音:噪声激励 + 延迟环低通反馈。
 * @param freq 频率 Hz
 * @param seconds 时长
 * @param velocity 力度 0~1
 * @param damping 反馈低通强度 0(明亮)~1(闷/掌闷)
 * @param decay 反馈增益(衰减速度),0.99x
 */
function pluck(freq, seconds, velocity = 1, damping = 0.35, decay = 0.996) {
  const n = Math.floor(seconds * SR);
  const period = Math.round(SR / freq);
  const out = new Float32Array(n);
  const ring = new Float32Array(period);
  for (let i = 0; i < period; i++) {
    ring[i] = (Math.random() * 2 - 1) * (1 - i / period);
  }
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const cur = ring[idx];
    out[i] = cur * velocity;
    const nxt = ring[(idx + 1) % period];
    // 平均即低通:damping 控制明亮度,decay 控制余振
    ring[idx] = decay * ((1 - damping) * 0.5 * (cur + nxt) + damping * cur);
    idx = (idx + 1) % period;
  }
  return out;
}

/** 把音按开始时间混入总线 */
function mixInto(bus, note, startSec) {
  const start = Math.floor(startSec * SR);
  const len = Math.min(note.length, bus.length - start);
  for (let i = 0; i < len; i++) bus[start + i] += note[i];
}

// ---- 一段 E 小调电吉他 riff(约 7.5s,结尾余振) ----
// E2=82.41 A2=110 B2=123.47 D3=146.83 E3=164.81 G3=196 A3=220 B3=246.94 D4=293.66 E4=329.63
const E2 = 82.41, A2 = 110.0, B2 = 123.47, D3 = 146.83, E3 = 164.81,
  G3 = 196.0, A3 = 220.0, B3 = 246.94, D4 = 293.66, E4 = 329.63;

const TOTAL = 7.5;
const bus = new Float32Array(Math.floor(TOTAL * SR));

const riff = [
  // [freq, start, dur, vel, damping, decay] — 掌闷节奏 + 开音旋律 + 推弦感长音
  [E2, 0.0, 0.35, 0.9, 0.75, 0.985],
  [E2, 0.3, 0.3, 0.8, 0.75, 0.985],
  [G3, 0.6, 0.5, 1.0, 0.3, 0.9965],
  [A3, 1.0, 0.4, 0.95, 0.3, 0.996],
  [B3, 1.4, 0.55, 1.0, 0.25, 0.9965],
  [A3, 1.9, 0.35, 0.85, 0.35, 0.995],
  [G3, 2.25, 0.35, 0.9, 0.35, 0.995],
  [E3, 2.6, 0.5, 0.95, 0.3, 0.996],
  [E2, 3.0, 0.3, 0.85, 0.75, 0.985],
  [D3, 3.3, 0.4, 0.9, 0.35, 0.996],
  [E3, 3.7, 0.4, 0.95, 0.3, 0.996],
  [G3, 4.1, 0.4, 0.95, 0.3, 0.9965],
  [A3, 4.5, 0.4, 0.9, 0.3, 0.996],
  [D4, 4.9, 0.6, 1.0, 0.25, 0.9965],
  [B3, 5.4, 0.4, 0.9, 0.3, 0.996],
  [A2, 5.8, 0.5, 0.85, 0.5, 0.993],
  [B2, 6.2, 0.5, 0.85, 0.5, 0.993],
  [E3, 6.6, 0.9, 1.0, 0.22, 0.997], // 结尾长音余振
];

for (const [f, t, d, v, damp, dec] of riff) {
  mixInto(bus, pluck(f, d, v, damp, dec), t);
}

// 轻微软限幅 + 归一化到 -3dBFS
let peak = 0;
for (let i = 0; i < bus.length; i++) {
  bus[i] = Math.tanh(bus[i] * 0.9);
  const a = Math.abs(bus[i]);
  if (a > peak) peak = a;
}
const target = Math.pow(10, -3 / 20);
const g = target / Math.max(peak, 1e-6);
for (let i = 0; i < bus.length; i++) bus[i] *= g;

// ---- 写 16bit 立体声 WAV(双声道复制) ----
const frames = bus.length;
const dataSize = frames * 2 * 2;
const buf = Buffer.alloc(44 + dataSize);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + dataSize, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20); // PCM
buf.writeUInt16LE(2, 22); // stereo
buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28);
buf.writeUInt16LE(4, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(dataSize, 40);
for (let i = 0; i < frames; i++) {
  const s = Math.max(-1, Math.min(1, bus[i]));
  const v = Math.round(s * 32767);
  buf.writeInt16LE(v, 44 + i * 4);
  buf.writeInt16LE(v, 44 + i * 4 + 2);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, buf);
console.log(`已生成 ${OUT} (${(buf.length / 1024).toFixed(0)} KB, ${TOTAL}s, 峰值 -3dBFS)`);
