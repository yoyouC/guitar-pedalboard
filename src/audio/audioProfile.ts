/** 设备级音频档位；不属于 Rig，见 ADR-0009。 */
export type AudioProfile = 'realtime' | 'balanced' | 'stable';

export interface AudioProfileDefinition {
  id: AudioProfile;
  label: string;
  description: string;
  latencyHint: AudioContextLatencyCategory;
  inputLatencySeconds: number;
}

export const AUDIO_PROFILES: readonly AudioProfileDefinition[] = [
  {
    id: 'realtime',
    label: '实时演奏',
    description: '优先争取最低监听时延',
    latencyHint: 'interactive',
    inputLatencySeconds: 0,
  },
  {
    id: 'balanced',
    label: '平衡',
    description: '在时延、稳定性与功耗之间平衡',
    latencyHint: 'balanced',
    inputLatencySeconds: 0.02,
  },
  {
    id: 'stable',
    label: '稳定播放',
    description: '优先连续播放，可能不适合实时演奏',
    latencyHint: 'playback',
    inputLatencySeconds: 0.05,
  },
] as const;

/** Media Capture latency constraint 尚未进入所有 TypeScript DOM lib，运行时按标准特性使用。 */
export interface AudioInputConstraints extends MediaTrackConstraints {
  latency?: ConstrainDouble;
}

const PROFILE_KEY = 'guitar-pedalboard-audio-profile-v1';

export function isAudioProfile(value: unknown): value is AudioProfile {
  return value === 'realtime' || value === 'balanced' || value === 'stable';
}

export function audioProfileDefinition(profile: AudioProfile): AudioProfileDefinition {
  return AUDIO_PROFILES.find((entry) => entry.id === profile)!;
}

export function loadAudioProfile(storage: Pick<Storage, 'getItem'> | null = safeStorage()): AudioProfile {
  if (!storage) return 'realtime';
  try {
    const value = storage.getItem(PROFILE_KEY);
    return isAudioProfile(value) ? value : 'realtime';
  } catch {
    return 'realtime';
  }
}

export function saveAudioProfile(
  profile: AudioProfile,
  storage: Pick<Storage, 'setItem'> | null = safeStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(PROFILE_KEY, profile);
  } catch {
    /* 私密模式或禁用 storage 时保持内存设置 */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** AudioContext 创建参数。latencyHint/sampleRate 都是请求值，不是浏览器保证。 */
export function audioContextOptions(profile: AudioProfile): AudioContextOptions {
  return {
    latencyHint: audioProfileDefinition(profile).latencyHint,
    sampleRate: 48_000,
  };
}

/** 首次麦克风请求：低延迟/48k/mono 都用 ideal，三项语音处理始终关闭。 */
export function preferredMicConstraints(
  profile: AudioProfile,
  deviceId?: string,
): MediaStreamConstraints {
  const audio: AudioInputConstraints = {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    latency: { ideal: audioProfileDefinition(profile).inputLatencySeconds },
    sampleRate: { ideal: 48_000 },
    channelCount: { ideal: 1 },
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  return {
    audio,
  };
}

/** 可选约束失败后的兼容请求；绝不重新开启浏览器语音处理。 */
export function fallbackMicConstraints(deviceId?: string): MediaStreamConstraints {
  return {
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  };
}

export async function openMicWithFallback(
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
  profile: AudioProfile,
  deviceId?: string,
): Promise<{ stream: MediaStream; degraded: boolean }> {
  try {
    return { stream: await getUserMedia(preferredMicConstraints(profile, deviceId)), degraded: false };
  } catch {
    return { stream: await getUserMedia(fallbackMicConstraints(deviceId)), degraded: true };
  }
}
