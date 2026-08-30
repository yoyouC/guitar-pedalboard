/** 唯一的频段目录；稳定序列化身份由该 tuple 派生，不能依赖数组下标。 */
export const PRE_AMP_EQ_BANDS = [
  { key: 'hz31_25', label: '31.25', frequency: 31.25 },
  { key: 'hz62_5', label: '62.5', frequency: 62.5 },
  { key: 'hz125', label: '125', frequency: 125 },
  { key: 'hz250', label: '250', frequency: 250 },
  { key: 'hz500', label: '500', frequency: 500 },
  { key: 'hz1000', label: '1k', frequency: 1000 },
  { key: 'hz2000', label: '2k', frequency: 2000 },
  { key: 'hz4000', label: '4k', frequency: 4000 },
  { key: 'hz8000', label: '8k', frequency: 8000 },
  { key: 'hz16000', label: '16k', frequency: 16000 },
] as const;

export type PreAmpEqBandDefinition = (typeof PRE_AMP_EQ_BANDS)[number];
export type PreAmpEqBandKey = PreAmpEqBandDefinition['key'];
export type PreAmpEqCutKind = 'lowCut' | 'highCut';

export const PRE_AMP_EQ_MIN_DB = -12;
export const PRE_AMP_EQ_MAX_DB = 12;
export const PRE_AMP_EQ_STEP_DB = 0.5;
export const PRE_AMP_EQ_SMOOTH_SECONDS = 0.02;
export const PRE_AMP_EQ_CUT_Q = Math.SQRT1_2;
export const PRE_AMP_EQ_LOW_CUT_MIN_HZ = 20;
export const PRE_AMP_EQ_LOW_CUT_MAX_HZ = 500;
export const PRE_AMP_EQ_LOW_CUT_DEFAULT_HZ = 80;
export const PRE_AMP_EQ_HIGH_CUT_MIN_HZ = 1000;
export const PRE_AMP_EQ_HIGH_CUT_MAX_HZ = 20000;
export const PRE_AMP_EQ_HIGH_CUT_DEFAULT_HZ = 12000;
/** Biquad 不引入显式缓冲；相位响应不计作链路 sample latency。 */
export const PRE_AMP_EQ_LATENCY = { processingSamples: 0, designSamples: 0 } as const;

/** 所有 canonical 写入共享的有限值、范围与 0.5 dB 网格约束。 */
export function normalizePreAmpEqDb(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const clamped = Math.min(PRE_AMP_EQ_MAX_DB, Math.max(PRE_AMP_EQ_MIN_DB, value));
  return Math.round(clamped / PRE_AMP_EQ_STEP_DB) * PRE_AMP_EQ_STEP_DB;
}

/** 高低切 canonical 频率统一限制到各自范围，并量化为整数 Hz。 */
export function normalizePreAmpEqCutFrequency(
  kind: PreAmpEqCutKind,
  value: unknown,
  fallback = kind === 'lowCut'
    ? PRE_AMP_EQ_LOW_CUT_DEFAULT_HZ
    : PRE_AMP_EQ_HIGH_CUT_DEFAULT_HZ,
): number {
  const min = kind === 'lowCut' ? PRE_AMP_EQ_LOW_CUT_MIN_HZ : PRE_AMP_EQ_HIGH_CUT_MIN_HZ;
  const max = kind === 'lowCut' ? PRE_AMP_EQ_LOW_CUT_MAX_HZ : PRE_AMP_EQ_HIGH_CUT_MAX_HZ;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(max, Math.max(min, value)));
}

export type PreAmpEqBands = Record<PreAmpEqBandKey, number>;

export interface PreAmpEqCutState {
  enabled: boolean;
  frequencyHz: number;
}

export interface PreAmpEqState {
  enabled: boolean;
  lowCut: PreAmpEqCutState;
  bands: PreAmpEqBands;
  highCut: PreAmpEqCutState;
  levelDb: number;
}

export function createDefaultPreAmpEqBands(): PreAmpEqBands {
  return Object.fromEntries(PRE_AMP_EQ_BANDS.map((band) => [band.key, 0])) as PreAmpEqBands;
}

export function createDefaultPreAmpEqState(): PreAmpEqState {
  return {
    enabled: false,
    lowCut: { enabled: false, frequencyHz: PRE_AMP_EQ_LOW_CUT_DEFAULT_HZ },
    bands: createDefaultPreAmpEqBands(),
    highCut: { enabled: false, frequencyHz: PRE_AMP_EQ_HIGH_CUT_DEFAULT_HZ },
    levelDb: 0,
  };
}

export function clonePreAmpEqState(state: PreAmpEqState): PreAmpEqState {
  return {
    enabled: state.enabled,
    lowCut: { ...state.lowCut },
    bands: { ...state.bands },
    highCut: { ...state.highCut },
    levelDb: state.levelDb,
  };
}

export interface PreAmpEqRuntime {
  input: GainNode;
  output: GainNode;
  setEnabled(enabled: boolean): void;
  setBand(key: PreAmpEqBandKey, gainDb: number): void;
  setLevel(levelDb: number): void;
  setCutEnabled(kind: PreAmpEqCutKind, enabled: boolean): void;
  setCutFrequency(kind: PreAmpEqCutKind, frequencyHz: number): void;
  setState(state: PreAmpEqState): void;
  dispose(): void;
}

interface CutRuntime {
  filter: BiquadFilterNode;
  dry: GainNode;
  wet: GainNode;
  sum: GainNode;
}

const dbToGain = (db: number): number => 10 ** (db / 20);

/** 旁路增益用有限线性淡变，结束点得到真正的 0/1 干湿状态。 */
function rampExactly(param: AudioParam, value: number, now: number): void {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(now);
  } else {
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
  }
  param.linearRampToValueAtTime(value, now + PRE_AMP_EQ_SMOOTH_SECONDS);
}

function createCutRuntime(
  ctx: AudioContext,
  source: AudioNode,
  kind: PreAmpEqCutKind,
  state: PreAmpEqCutState,
  audible: boolean,
): CutRuntime {
  const dry = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  const wet = ctx.createGain();
  const sum = ctx.createGain();
  filter.type = kind === 'lowCut' ? 'highpass' : 'lowpass';
  filter.frequency.value = kind === 'highCut'
    ? Math.min(state.frequencyHz, ctx.sampleRate * 0.45)
    : state.frequencyHz;
  filter.Q.value = PRE_AMP_EQ_CUT_Q;
  dry.gain.value = audible ? 0 : 1;
  wet.gain.value = audible ? 1 : 0;
  source.connect(dry);
  source.connect(filter);
  filter.connect(wet);
  dry.connect(sum);
  wet.connect(sum);
  return { filter, dry, wet, sum };
}

export function createPreAmpEqRuntime(
  ctx: AudioContext,
  initialState: PreAmpEqState,
): PreAmpEqRuntime {
  const input = ctx.createGain();
  const lowCut = createCutRuntime(
    ctx,
    input,
    'lowCut',
    initialState.lowCut,
    initialState.enabled && initialState.lowCut.enabled,
  );
  const filters = new Map<PreAmpEqBandKey, BiquadFilterNode>();
  let previous: AudioNode = lowCut.sum;
  for (const band of PRE_AMP_EQ_BANDS) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'peaking';
    filter.frequency.value = Math.min(band.frequency, ctx.sampleRate * 0.45);
    filter.Q.value = Math.SQRT2;
    filter.gain.value = initialState.enabled ? initialState.bands[band.key] : 0;
    previous.connect(filter);
    previous = filter;
    filters.set(band.key, filter);
  }
  const highCut = createCutRuntime(
    ctx,
    previous,
    'highCut',
    initialState.highCut,
    initialState.enabled && initialState.highCut.enabled,
  );
  const output = ctx.createGain();
  output.gain.value = initialState.enabled ? dbToGain(initialState.levelDb) : 1;
  highCut.sum.connect(output);

  let state = clonePreAmpEqState(initialState);
  const cuts: Record<PreAmpEqCutKind, CutRuntime> = { lowCut, highCut };

  const smoothCutMix = (kind: PreAmpEqCutKind): void => {
    const cut = cuts[kind];
    const audible = state.enabled && state[kind].enabled;
    rampExactly(cut.dry.gain, audible ? 0 : 1, ctx.currentTime);
    rampExactly(cut.wet.gain, audible ? 1 : 0, ctx.currentTime);
  };

  const smoothAudibleState = (): void => {
    smoothCutMix('lowCut');
    for (const band of PRE_AMP_EQ_BANDS) {
      filters
        .get(band.key)!
        .gain.setTargetAtTime(state.enabled ? state.bands[band.key] : 0, ctx.currentTime, PRE_AMP_EQ_SMOOTH_SECONDS);
    }
    smoothCutMix('highCut');
    output.gain.setTargetAtTime(
      state.enabled ? dbToGain(state.levelDb) : 1,
      ctx.currentTime,
      PRE_AMP_EQ_SMOOTH_SECONDS,
    );
  };

  const smoothCutFrequency = (kind: PreAmpEqCutKind): void => {
    const nominal = state[kind].frequencyHz;
    const actual = kind === 'highCut' ? Math.min(nominal, ctx.sampleRate * 0.45) : nominal;
    cuts[kind].filter.frequency.setTargetAtTime(
      actual,
      ctx.currentTime,
      PRE_AMP_EQ_SMOOTH_SECONDS,
    );
  };

  return {
    input,
    output,
    setEnabled(enabled): void {
      state.enabled = enabled;
      smoothAudibleState();
    },
    setBand(key, gainDb): void {
      state.bands[key] = gainDb;
      if (state.enabled) {
        filters.get(key)!.gain.setTargetAtTime(gainDb, ctx.currentTime, PRE_AMP_EQ_SMOOTH_SECONDS);
      }
    },
    setLevel(levelDb): void {
      state.levelDb = levelDb;
      if (state.enabled) {
        output.gain.setTargetAtTime(dbToGain(levelDb), ctx.currentTime, PRE_AMP_EQ_SMOOTH_SECONDS);
      }
    },
    setCutEnabled(kind, enabled): void {
      state[kind].enabled = enabled;
      smoothCutMix(kind);
    },
    setCutFrequency(kind, frequencyHz): void {
      state[kind].frequencyHz = frequencyHz;
      smoothCutFrequency(kind);
    },
    setState(nextState): void {
      state = clonePreAmpEqState(nextState);
      smoothCutFrequency('lowCut');
      smoothCutFrequency('highCut');
      smoothAudibleState();
    },
    dispose(): void {
      input.disconnect();
      for (const cut of Object.values(cuts)) {
        cut.filter.disconnect();
        cut.dry.disconnect();
        cut.wet.disconnect();
        cut.sum.disconnect();
      }
      for (const filter of filters.values()) filter.disconnect();
      output.disconnect();
    },
  };
}
