import type { AuthenticatedIdentity } from '../auth/session.ts';

export const HANDLE_CHANGE_INTERVAL_MS = 90 * 24 * 60 * 60 * 1000;

export interface MemberRecord {
  id: string;
  authUserId: string | null;
  handle: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  handleChangedAt: Date | null;
  termsAcceptedVersion: string | null;
  publicProfileCompletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMemberInput {
  id: string;
  identity: AuthenticatedIdentity;
  handle: string;
  now: Date;
}

export interface UpdateMemberProfileInput {
  handle?: string;
  displayName?: string;
  bio?: string;
  termsAcceptedVersion?: string;
  expectedUpdatedAt: Date;
}

export type HandleResolution =
  | { kind: 'current'; member: MemberRecord }
  | { kind: 'redirect'; member: MemberRecord }
  | { kind: 'missing' };

export class HandleUnavailableError extends Error {}

export class MemberUpdateConflictError extends Error {}

export class HandleChangeTooSoonError extends Error {
  readonly nextHandleChangeAt: Date;

  constructor(nextHandleChangeAt: Date) {
    super('Handle cannot be changed yet');
    this.nextHandleChangeAt = nextHandleChangeAt;
  }
}

export interface MemberRepository {
  findOrCreateForIdentity(input: CreateMemberInput): Promise<MemberRecord>;
  resolveHandle(handle: string): Promise<HandleResolution>;
  updateProfile(memberId: string, update: UpdateMemberProfileInput, now: Date): Promise<MemberRecord>;
}

export function isReadyForPublicAttribution(
  member: MemberRecord,
  currentTermsVersion: string,
): boolean {
  return member.publicProfileCompletedAt !== null
    && member.termsAcceptedVersion === currentTermsVersion;
}
