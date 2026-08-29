export interface PedalboardCapability {
  supported: boolean;
  missing: Array<'secure-context' | 'audio-context' | 'audio-worklet' | 'microphone'>;
}

export interface PedalboardCapabilityEnvironment {
  isSecureContext?: boolean;
  AudioContext?: unknown;
  webkitAudioContext?: unknown;
  AudioWorkletNode?: unknown;
  mediaDevices?: { getUserMedia?: unknown };
}

export function detectPedalboardCapability(
  environment: PedalboardCapabilityEnvironment,
): PedalboardCapability {
  const missing: PedalboardCapability['missing'] = [];
  if (environment.isSecureContext === false) missing.push('secure-context');
  if (typeof environment.AudioContext !== 'function'
    && typeof environment.webkitAudioContext !== 'function') missing.push('audio-context');
  if (typeof environment.AudioWorkletNode !== 'function') missing.push('audio-worklet');
  if (typeof environment.mediaDevices?.getUserMedia !== 'function') missing.push('microphone');
  return { supported: missing.length === 0, missing };
}

export function browserPedalboardCapability(): PedalboardCapability {
  const browser = window as Window & {
    webkitAudioContext?: unknown;
    AudioWorkletNode?: unknown;
  };
  return detectPedalboardCapability({
    isSecureContext: window.isSecureContext,
    AudioContext: window.AudioContext,
    webkitAudioContext: browser.webkitAudioContext,
    AudioWorkletNode: browser.AudioWorkletNode ?? globalThis.AudioWorkletNode,
    mediaDevices: navigator.mediaDevices,
  });
}
