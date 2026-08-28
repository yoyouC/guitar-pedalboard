import type { EffectInstance } from './effects/types';
import { levelDbToGain } from './level';

const CROSSFADE_SECONDS = 0.03;
const CROSSFADE_STEPS = 16;
const LEVEL_SMOOTH_SECONDS = 0.03;

interface CabLane {
  convolver: ConvolverNode;
  gain: GainNode;
  calibrationGain: number;
}

export interface CabIrEffectInstance extends EffectInstance {
  /** buffer 必须已在当前 context 解码；调用不会改写正在发声的 Convolver.buffer。 */
  switchBuffer(buffer: AudioBuffer, calibrationDb?: number): void;
}

function createLane(
  ctx: AudioContext,
  input: GainNode,
  output: GainNode,
  buffer: AudioBuffer,
  gainValue: number,
  calibrationGain: number,
): CabLane {
  const convolver = ctx.createConvolver();
  convolver.normalize = false;
  convolver.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = gainValue;
  input.connect(convolver);
  convolver.connect(gain);
  gain.connect(output);
  return { convolver, gain, calibrationGain };
}

function disconnectLane(lane: CabLane): void {
  lane.convolver.disconnect();
  lane.gain.disconnect();
}

/** 双 Convolver lane，30ms 等功率曲线切换；输入/输出节点身份稳定。 */
export function createCabIrEffect(
  ctx: AudioContext,
  initialBuffer: AudioBuffer,
  initialLevelDb = -6,
  initialCalibrationDb = 0,
): CabIrEffectInstance {
  const input = ctx.createGain();
  const output = ctx.createGain();
  output.gain.value = levelDbToGain(initialLevelDb);
  let active = createLane(
    ctx,
    input,
    output,
    initialBuffer,
    levelDbToGain(initialCalibrationDb),
    levelDbToGain(initialCalibrationDb),
  );
  let fadingOut: CabLane | null = null;
  let pending: { buffer: AudioBuffer; calibrationDb: number } | null = null;
  let transitionTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const startTransition = (buffer: AudioBuffer, calibrationDb: number) => {
    const previous = active;
    const nextCalibrationGain = levelDbToGain(calibrationDb);
    const next = createLane(ctx, input, output, buffer, 0, nextCalibrationGain);
    fadingOut = previous;
    const start = ctx.currentTime;
    previous.gain.gain.cancelScheduledValues(start);
    next.gain.gain.cancelScheduledValues(start);
    previous.gain.gain.setValueAtTime(previous.gain.gain.value, start);
    next.gain.gain.setValueAtTime(0, start);
    for (let step = 1; step <= CROSSFADE_STEPS; step++) {
      const progress = step / CROSSFADE_STEPS;
      const when = start + CROSSFADE_SECONDS * progress;
      previous.gain.gain.linearRampToValueAtTime(
        previous.calibrationGain * Math.cos(progress * Math.PI * 0.5),
        when,
      );
      next.gain.gain.linearRampToValueAtTime(
        next.calibrationGain * Math.sin(progress * Math.PI * 0.5),
        when,
      );
    }
    active = next;
    transitionTimer = globalThis.setTimeout(() => {
      transitionTimer = null;
      disconnectLane(previous);
      if (fadingOut === previous) fadingOut = null;
      if (disposed) return;
      const queued = pending;
      pending = null;
      if (queued) startTransition(queued.buffer, queued.calibrationDb);
    }, CROSSFADE_SECONDS * 1000 + 5);
  };

  return {
    input,
    output,
    switchBuffer(buffer, calibrationDb = 0) {
      if (disposed) return;
      if (transitionTimer !== null) {
        pending = { buffer, calibrationDb };
        return;
      }
      startTransition(buffer, calibrationDb);
    },
    update(key, value) {
      if (key === 'level') {
        output.gain.setTargetAtTime(levelDbToGain(value), ctx.currentTime, LEVEL_SMOOTH_SECONDS);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (transitionTimer !== null) clearTimeout(transitionTimer);
      transitionTimer = null;
      pending = null;
      input.disconnect();
      if (fadingOut && fadingOut !== active) disconnectLane(fadingOut);
      fadingOut = null;
      disconnectLane(active);
      output.disconnect();
    },
  };
}
