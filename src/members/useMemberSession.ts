import { useSyncExternalStore } from 'react';
import { memberSession } from './session.ts';

export function useMemberSession() {
  return useSyncExternalStore(memberSession.subscribe, memberSession.getState, memberSession.getState);
}

