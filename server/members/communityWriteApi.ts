import type { MemberRecord } from './repository.ts';
import type { AuthenticatedIdentity } from '../auth/session.ts';
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

export function unverifiedEmailWriteDenied(
  identity: AuthenticatedIdentity,
  returnPath: string,
): Response | null {
  if (identity.emailVerified !== false) return null;
  return emailVerificationRequired(returnPath);
}

export function emailVerificationRequired(returnPath: string): Response {
  const verificationUrl = `/login?verify=email&return=${encodeURIComponent(returnPath)}`;
  return Response.json({
    error: {
      code: 'email_verification_required',
      message: 'Verify your email before this community write',
      verificationUrl,
    },
  }, { status: 403 });
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
