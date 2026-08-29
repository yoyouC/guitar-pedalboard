import type { MemberProfile } from '../../shared/members.ts';
import {
  fetchCurrentMember,
  MemberClientError,
  signOut,
  type FetchLike,
} from './client.ts';

export type MemberSessionState =
  | { status: 'loading'; member: null; message: '' }
  | { status: 'anonymous'; member: null; message: '' }
  | { status: 'authenticated'; member: MemberProfile; message: '' }
  | { status: 'unavailable'; member: null; message: string };

export interface MemberSession {
  getState(): MemberSessionState;
  subscribe(listener: () => void): () => void;
  load(): Promise<MemberSessionState>;
  refresh(): Promise<MemberSessionState>;
  replaceMember(member: MemberProfile): void;
  logout(): Promise<void>;
}

export function createMemberSession(fetch: FetchLike = globalThis.fetch): MemberSession {
  let state: MemberSessionState = { status: 'loading', member: null, message: '' };
  let loading: Promise<MemberSessionState> | null = null;
  const listeners = new Set<() => void>();

  const setState = (next: MemberSessionState) => {
    state = next;
    listeners.forEach((listener) => listener());
    return next;
  };

  const request = () => {
    if (loading) return loading;
    loading = fetchCurrentMember(fetch)
      .then((member) => setState({ status: 'authenticated', member, message: '' }))
      .catch((cause: unknown) => {
        if (cause instanceof MemberClientError && cause.code === 'authentication_required') {
          return setState({ status: 'anonymous', member: null, message: '' });
        }
        return setState({
          status: 'unavailable',
          member: null,
          message: cause instanceof Error ? cause.message : 'Member service is unavailable',
        });
      })
      .finally(() => { loading = null; });
    return loading;
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load: request,
    refresh() {
      setState({ status: 'loading', member: null, message: '' });
      return request();
    },
    replaceMember(member) {
      setState({ status: 'authenticated', member, message: '' });
    },
    async logout() {
      await signOut(fetch);
      setState({ status: 'anonymous', member: null, message: '' });
    },
  };
}

export const memberSession = createMemberSession();

