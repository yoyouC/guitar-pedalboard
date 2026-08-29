import type { MemberRecord } from './repository.ts';

export class BannedMemberError extends Error {}
export class AccountDeletionPendingError extends Error {}

export function assertAccountActive(member: MemberRecord): void {
  if (member.accountStatus === 'pending_deletion' || member.accountStatus === 'tombstoned') {
    throw new AccountDeletionPendingError();
  }
}

export function assertCommunityWriteAllowed(member: MemberRecord): void {
  assertAccountActive(member);
  if (member.communityStatus === 'banned') throw new BannedMemberError();
}
