/**
 * 共享 4 段音色栈(issue #5)。
 *
 * 链:bass(lowshelf 120Hz)→ mid(peaking 700Hz Q1)→ treble(highshelf 3200Hz)
 *     → presence(highshelf 5000Hz),内部连接由本模块完成。
 * 映射:bass/mid/treble 旋钮百分比 → ±12dB;presence 0~100 → 0~8dB;
 * update 用 setTargetAtTime 平滑(时间常数 0.03s,与各调用点原值一致)。
 *
 * 行为由 tests/tone-stack.test.ts 的 pin 测试钉死:采用本模块前后的
 * 频率、Q、连接顺序与映射必须逐点一致。wdftwin 偏离(mid 500/treble 3000),
 * 不采用本模块。
 */

const SMOOTHING = 0.03;

const pctToDb = (v: number, range: number) => ((v - 50) / 50) * range;

export interface ToneStackDefaults {
  bass: number;
  mid: number;
  treble: number;
  presence: number;
}

export interface ToneStack {
  /** 链入口(bass 节点):前级 connect 到这里 */
  input: BiquadFilterNode;
  /** 链出口(presence 节点):接到后级 */
  output: BiquadFilterNode;
  /** 栈内 4 个节点(dispose 列表需要展开时用) */
  nodes: BiquadFilterNode[];
  /** 处理 bass/mid/treble/presence 键;已处理返回 true,其余键返回 false */
  update(key: string, value: number): boolean;
}

export function createToneStack(ctx: AudioContext, defaults: ToneStackDefaults): ToneStack {
  const bass = ctx.createBiquadFilter();
  bass.type = 'lowshelf';
  bass.frequency.value = 120;
  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = 700;
  mid.Q.value = 1;
  const treble = ctx.createBiquadFilter();
  treble.type = 'highshelf';
  treble.frequency.value = 3200;
  const presence = ctx.createBiquadFilter();
  presence.type = 'highshelf';
  presence.frequency.value = 5000;

  bass.gain.value = pctToDb(defaults.bass, 12);
  mid.gain.value = pctToDb(defaults.mid, 12);
  treble.gain.value = pctToDb(defaults.treble, 12);
  presence.gain.value = (defaults.presence / 100) * 8;

  bass.connect(mid);
  mid.connect(treble);
  treble.connect(presence);

  return {
    input: bass,
    output: presence,
    nodes: [bass, mid, treble, presence],
    update(key, value) {
      const t = ctx.currentTime;
      switch (key) {
        case 'bass':
          bass.gain.setTargetAtTime(pctToDb(value, 12), t, SMOOTHING);
          return true;
        case 'mid':
          mid.gain.setTargetAtTime(pctToDb(value, 12), t, SMOOTHING);
          return true;
        case 'treble':
          treble.gain.setTargetAtTime(pctToDb(value, 12), t, SMOOTHING);
          return true;
        case 'presence':
          presence.gain.setTargetAtTime((value / 100) * 8, t, SMOOTHING);
          return true;
        default:
          return false;
      }
    },
  };
}
