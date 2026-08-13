import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createStubAudioContext,
  StubAudioNode,
  type StubBiquadFilterNode,
} from './helpers/stub-audio-context.ts';
import { getAmpDef } from '../src/audio/amps.ts';

/**
 * 音色栈 pin 测试(issue #5):在任何重构之前,把每个候选调用点今天的
 * 频率、Q、连接顺序与 参数→增益映射 钉死。采用共享 tone-stack 模块后,
 * 这些测试必须原样继续通过。
 *
 * 规范链:bass(lowshelf 120Hz)→ mid(peaking 700Hz Q1)→ treble(highshelf 3200Hz)
 *         → presence(highshelf 5000Hz)
 * 映射:bass/mid/treble 百分比 → ±12dB;presence 0~100 → 0~8dB。
 */

const pctToDb = (v: number, range: number) => ((v - 50) / 50) * range;
const presenceToDb = (v: number) => (v / 100) * 8;

interface BandSpec {
  key: 'bass' | 'mid' | 'treble' | 'presence';
  type: BiquadFilterType;
  frequency: number;
  /** 仅 mid 需要钉 Q */
  Q?: number;
}

const CANONICAL: BandSpec[] = [
  { key: 'bass', type: 'lowshelf', frequency: 120 },
  { key: 'mid', type: 'peaking', frequency: 700, Q: 1 },
  { key: 'treble', type: 'highshelf', frequency: 3200 },
  { key: 'presence', type: 'highshelf', frequency: 5000 },
];

/** twin 的音色栈偏离规范:mid 500Hz、treble 3000Hz(见 twinAmpDef 注释) */
const TWIN: BandSpec[] = [
  { key: 'bass', type: 'lowshelf', frequency: 120 },
  { key: 'mid', type: 'peaking', frequency: 500, Q: 1 },
  { key: 'treble', type: 'highshelf', frequency: 3000 },
  { key: 'presence', type: 'highshelf', frequency: 5000 },
];

interface SiteSpec {
  ampId: string;
  bands: BandSpec[];
  defaults: { bass: number; mid: number; treble: number; presence: number };
}

const SITES: SiteSpec[] = [
  // createAmp 的三个采用者 + createCrunchAmp(crunch 为 customCreate)
  { ampId: 'clean', bands: CANONICAL, defaults: { bass: 55, mid: 45, treble: 65, presence: 50 } },
  { ampId: 'crunch', bands: CANONICAL, defaults: { bass: 50, mid: 65, treble: 60, presence: 55 } },
  { ampId: 'recto', bands: CANONICAL, defaults: { bass: 60, mid: 40, treble: 60, presence: 60 } },
  { ampId: 'chime', bands: CANONICAL, defaults: { bass: 45, mid: 55, treble: 65, presence: 65 } },
  // wdfBognerDef(amps.ts)
  { ampId: 'wdfbogner', bands: CANONICAL, defaults: { bass: 50, mid: 60, treble: 60, presence: 55 } },
  // wdfJc120Def(wdf/jc120AmpDef.ts)
  { ampId: 'wdfjc120', bands: CANONICAL, defaults: { bass: 50, mid: 50, treble: 60, presence: 60 } },
  // createNamWasmAmp(namWasm.ts)
  { ampId: 'nam-wasm', bands: CANONICAL, defaults: { bass: 50, mid: 50, treble: 50, presence: 50 } },
  // wdfTwinDef(wdf/twinAmpDef.ts):偏离规范,钉死今日值
  { ampId: 'wdftwin', bands: TWIN, defaults: { bass: 55, mid: 40, treble: 60, presence: 50 } },
];

const expectedDb = (key: BandSpec['key'], v: number) =>
  key === 'presence' ? presenceToDb(v) : pctToDb(v, 12);

for (const site of SITES) {
  test(`音色栈 pin[${site.ampId}]:频率/Q、连接顺序、初始增益与 update 映射`, () => {
    const ctx = createStubAudioContext();
    const def = getAmpDef(site.ampId);
    const inst = def.create(ctx as unknown as AudioContext);

    // 按 type+频率 找到各段节点;twin 的 voicing 与 mid 同为 peaking@500,
    // 用初始增益区分(voicing 固定 -3dB,mid 由默认旋钮位决定)
    const bandNodes = new Map<string, StubBiquadFilterNode>();
    for (const band of site.bands) {
      const candidates = ctx
        .nodesOfKind<StubBiquadFilterNode>('BiquadFilterNode')
        .filter((n) => n.type === band.type && n.frequency.value === band.frequency);
      const node =
        candidates.length === 1
          ? candidates[0]
          : candidates.find((n) => n.gain.value === expectedDb(band.key, site.defaults[band.key]));
      assert.ok(node, `${site.ampId}: 找不到 ${band.key}(${band.type}@${band.frequency}Hz)`);
      if (band.Q !== undefined) assert.equal(node.Q.value, band.Q, `${site.ampId}: ${band.key} Q`);
      bandNodes.set(band.key, node);
    }

    // 连接顺序:bass → mid → treble → presence
    const order: BandSpec['key'][] = ['bass', 'mid', 'treble', 'presence'];
    for (let i = 0; i < order.length - 1; i++) {
      const from = bandNodes.get(order[i])!;
      const to = bandNodes.get(order[i + 1])!;
      assert.ok(
        ctx.isConnected(from, to as unknown as StubAudioNode),
        `${site.ampId}: ${order[i]} 未直连 ${order[i + 1]}`,
      );
    }

    // 初始增益:百分比 → dB 映射(直接 value 赋值)
    for (const band of site.bands) {
      const node = bandNodes.get(band.key)!;
      assert.equal(
        node.gain.value,
        expectedDb(band.key, site.defaults[band.key]),
        `${site.ampId}: ${band.key} 初始增益`,
      );
    }

    // update 映射:setTargetAtTime(mapped, currentTime, 0.03)
    for (const band of site.bands) {
      const node = bandNodes.get(band.key)!;
      const before = node.gain.callsOf('setTargetAtTime').length;
      inst.update(band.key, 75);
      const calls = node.gain.callsOf('setTargetAtTime');
      assert.equal(calls.length, before + 1, `${site.ampId}: update('${band.key}') 未到达对应频段`);
      assert.deepEqual(calls.at(-1)?.args, [expectedDb(band.key, 75), 0, 0.03]);
    }

    inst.dispose();
  });
}
