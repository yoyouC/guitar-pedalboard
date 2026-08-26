import type { AudioProfile } from './audioProfile';
import type { RigLatency } from './latency';
import type { MainThreadSnapshot, StabilityObservation } from './performanceDiagnostics';

export type LatencyBand = 'good' | 'warn' | 'bad' | 'unknown';

export interface LatencyWindowSnapshot {
  medianMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  samples: number;
}

/** 最近五次输出估算的滑窗；调用方按 1Hz 采样即对应五秒窗口。 */
export class LatencyWindow {
  private values: number[] = [];
  private readonly capacity: number;

  constructor(capacity = 5) {
    this.capacity = capacity;
  }

  push(valueMs: number | null): LatencyWindowSnapshot {
    if (valueMs !== null && Number.isFinite(valueMs) && valueMs >= 0) {
      this.values.push(valueMs);
      if (this.values.length > this.capacity) this.values.shift();
    }
    return this.snapshot();
  }

  clear(): LatencyWindowSnapshot {
    this.values = [];
    return this.snapshot();
  }

  snapshot(): LatencyWindowSnapshot {
    if (this.values.length === 0) return { medianMs: null, minMs: null, maxMs: null, samples: 0 };
    const sorted = [...this.values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const medianMs =
      sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
    return {
      medianMs,
      minMs: sorted[0],
      maxMs: sorted[sorted.length - 1],
      samples: sorted.length,
    };
  }
}

export interface PlaybackStatsSnapshot {
  supported: boolean;
  underrunEvents: number | null;
  underrunDurationMs: number | null;
  averageLatencyMs: number | null;
  minimumLatencyMs: number | null;
  maximumLatencyMs: number | null;
}

export interface AudioDiagnosticsSnapshot {
  ready: boolean;
  /** Context 事务提交后自增，供持有 Context 节点的 UI 重建自身。 */
  runtimeVersion: number;
  profile: AudioProfile;
  profileIgnored: boolean;
  degradedInput: boolean;
  workletFailures: string[];
  warning: string | null;
  baseLatencyMs: number | null;
  outputLatencyMs: number | null;
  outputEstimate: LatencyWindowSnapshot;
  sampleRate: number | null;
  inputSettings: MediaTrackSettings | null;
  playback: PlaybackStatsSnapshot;
  mainThread: MainThreadSnapshot;
  stabilityObservation: StabilityObservation | null;
  rigLatency: RigLatency | null;
  calibrationMs: number | null;
}

export function latencyBand(valueMs: number | null): LatencyBand {
  if (valueMs === null || !Number.isFinite(valueMs)) return 'unknown';
  if (valueMs <= 10) return 'good';
  if (valueMs <= 20) return 'warn';
  return 'bad';
}

function finiteMilliseconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value * 1000 : null;
}

interface ExperimentalPlaybackStats {
  underrunEvents?: number;
  underrunDuration?: number;
  averageLatency?: number;
  minimumLatency?: number;
  maximumLatency?: number;
}

export function readPlaybackStats(ctx: AudioContext): PlaybackStatsSnapshot {
  const stats = (ctx as AudioContext & { playbackStats?: ExperimentalPlaybackStats }).playbackStats;
  if (!stats) {
    return {
      supported: false,
      underrunEvents: null,
      underrunDurationMs: null,
      averageLatencyMs: null,
      minimumLatencyMs: null,
      maximumLatencyMs: null,
    };
  }
  return {
    supported: true,
    underrunEvents: typeof stats.underrunEvents === 'number' ? stats.underrunEvents : null,
    underrunDurationMs: finiteMilliseconds(stats.underrunDuration),
    averageLatencyMs: finiteMilliseconds(stats.averageLatency),
    minimumLatencyMs: finiteMilliseconds(stats.minimumLatency),
    maximumLatencyMs: finiteMilliseconds(stats.maximumLatency),
  };
}

export interface DiagnosticExportInput {
  snapshot: AudioDiagnosticsSnapshot;
  appVersion: string;
  browser: string;
  os: string;
  rigComplexity: { pedals: number; namModules: number; wdfModules: number };
  inputDeviceLabel?: string;
  outputDeviceLabel?: string;
  includeDeviceNames?: boolean;
}

/** 明确白名单导出；不会接收 deviceId、Preset 名称或外部 NAM 引用。 */
export function createDiagnosticExport(input: DiagnosticExportInput): Record<string, unknown> {
  const { inputSettings, ...safeSnapshot } = input.snapshot;
  const settings = inputSettings as (MediaTrackSettings & { latency?: number }) | null;
  const safeInputSettings = settings
    ? {
        sampleRate: settings.sampleRate ?? null,
        channelCount: settings.channelCount ?? null,
        latency: settings.latency ?? null,
        echoCancellation: settings.echoCancellation ?? null,
        noiseSuppression: settings.noiseSuppression ?? null,
        autoGainControl: settings.autoGainControl ?? null,
      }
    : null;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    appVersion: input.appVersion,
    browser: input.browser,
    os: input.os,
    audio: { ...safeSnapshot, inputSettings: safeInputSettings },
    rigComplexity: input.rigComplexity,
    ...(input.includeDeviceNames
      ? {
          devices: {
            input: input.inputDeviceLabel || null,
            output: input.outputDeviceLabel || null,
          },
        }
      : {}),
  };
}
