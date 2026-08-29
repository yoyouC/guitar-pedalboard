import type { MemberRecord } from './repository.ts';
import {
  AccountDeletionPendingError,
  assertCommunityWriteAllowed,
  BannedMemberError,
} from './standing.ts';

export function communityWriteDenied(member: MemberRecord): Response | null {
  try {
    assertCommunityWriteAllowed(member);
    return null;
  } catch (cause) {
    return communityWriteErrorResponse(cause);
  }
}

export function communityWriteErrorResponse(cause: unknown): Response | null {
  if (cause instanceof AccountDeletionPendingError) {
    return Response.json({
      error: {
        code: 'account_deletion_pending',
        message: 'Account deletion is pending; recover the account before writing',
      },
    }, { status: 403 });
  }
  if (!(cause instanceof BannedMemberError)) return null;
  return Response.json({
    error: {
      code: 'member_banned',
      message: 'Banned members cannot perform community writes',
    },
  }, { status: 403 });
}
