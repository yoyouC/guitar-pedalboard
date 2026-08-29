import { useSyncExternalStore } from 'react';
import { createPublishedPresetRigSession } from './applyPublishedPreset';
import { rigStore } from '../state/useRig';

function browserSessionStorage(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage; } catch { return undefined; }
}

export const toneSession = createPublishedPresetRigSession(rigStore, browserSessionStorage());

export function useToneSession() {
  return useSyncExternalStore(toneSession.subscribe, toneSession.getState);
}
