import type { MemberRecord } from './repository.ts';

export class BannedMemberError extends Error {}

export function assertCommunityWriteAllowed(member: MemberRecord): void {
  if (member.communityStatus === 'banned') throw new BannedMemberError();
}
