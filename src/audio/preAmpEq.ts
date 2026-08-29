/** 箱头前均衡的稳定频段身份；序列化不能依赖数组下标。 */
export type PreAmpEqBandKey =
  | 'hz31_25'
  | 'hz62_5'
  | 'hz125'
  | 'hz250'
  | 'hz500'
  | 'hz1000'
  | 'hz2000'
  | 'hz4000'
  | 'hz8000'
  | 'hz16000';

export interface PreAmpEqBandDefinition {
  key: PreAmpEqBandKey;
  label: string;
  frequency: number;
}

export const PRE_AMP_EQ_BANDS: readonly PreAmpEqBandDefinition[] = [
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

export const PRE_AMP_EQ_MIN_DB = -12;
export const PRE_AMP_EQ_MAX_DB = 12;
export const PRE_AMP_EQ_STEP_DB = 0.5;
export const PRE_AMP_EQ_SMOOTH_SECONDS = 0.02;
/** Biquad 不引入显式缓冲；相位响应不计作链路 sample latency。 */
export const PRE_AMP_EQ_LATENCY = { processingSamples: 0, designSamples: 0 } as const;

export type PreAmpEqBands = Record<PreAmpEqBandKey, number>;

export interface PreAmpEqState {
  enabled: boolean;
  bands: PreAmpEqBands;
  levelDb: number;
}

export function createDefaultPreAmpEqBands(): PreAmpEqBands {
  return Object.fromEntries(PRE_AMP_EQ_BANDS.map((band) => [band.key, 0])) as PreAmpEqBands;
}

export function createDefaultPreAmpEqState(): PreAmpEqState {
  return { enabled: false, bands: createDefaultPreAmpEqBands(), levelDb: 0 };
}

export interface PreAmpEqRuntime {
  input: GainNode;
  output: GainNode;
  setEnabled(enabled: boolean): void;
  setBand(key: PreAmpEqBandKey, gainDb: number): void;
  setLevel(levelDb: number): void;
  setState(state: PreAmpEqState): void;
  dispose(): void;
}

const dbToGain = (db: number): number => 10 ** (db / 20);

export function createPreAmpEqRuntime(
  ctx: AudioContext,
  initialState: PreAmpEqState,
): PreAmpEqRuntime {
  const input = ctx.createGain();
  const filters = new Map<PreAmpEqBandKey, BiquadFilterNode>();
  let previous: AudioNode = input;
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
  const output = ctx.createGain();
  output.gain.value = initialState.enabled ? dbToGain(initialState.levelDb) : 1;
  previous.connect(output);

  let state: PreAmpEqState = {
    enabled: initialState.enabled,
    bands: { ...initialState.bands },
    levelDb: initialState.levelDb,
  };

  const smoothAudibleState = (): void => {
    for (const band of PRE_AMP_EQ_BANDS) {
      filters
        .get(band.key)!
        .gain.setTargetAtTime(state.enabled ? state.bands[band.key] : 0, ctx.currentTime, PRE_AMP_EQ_SMOOTH_SECONDS);
    }
    output.gain.setTargetAtTime(
      state.enabled ? dbToGain(state.levelDb) : 1,
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
    setState(nextState): void {
      state = {
        enabled: nextState.enabled,
        bands: { ...nextState.bands },
        levelDb: nextState.levelDb,
      };
      smoothAudibleState();
    },
    dispose(): void {
      input.disconnect();
      for (const filter of filters.values()) filter.disconnect();
      output.disconnect();
    },
  };
}
