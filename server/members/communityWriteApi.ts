import type { MemberRecord } from './repository.ts';
import { assertCommunityWriteAllowed, BannedMemberError } from './standing.ts';

export function communityWriteDenied(member: MemberRecord): Response | null {
  try {
    assertCommunityWriteAllowed(member);
    return null;
  } catch (cause) {
    return communityWriteErrorResponse(cause);
  }
}

export function communityWriteErrorResponse(cause: unknown): Response | null {
  if (!(cause instanceof BannedMemberError)) return null;
  return Response.json({
    error: {
      code: 'member_banned',
      message: 'Banned members cannot perform community writes',
    },
  }, { status: 403 });
}
