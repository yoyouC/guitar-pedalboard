import type { MemberProfile, PublicCreatorProfile } from '../../shared/members.ts';
import type { SessionVerifier } from '../auth/session.ts';
import type { MemberRecord, MemberRepository, UpdateMemberProfileInput } from './repository.ts';
import type { PublicCreatorWorks } from './works.ts';
import {
  HANDLE_CHANGE_INTERVAL_MS,
  HandleChangeTooSoonError,
  HandleUnavailableError,
  MemberUpdateConflictError,
} from './repository.ts';
import { communityWriteDenied } from './communityWriteApi.ts';

const ME_PATH = '/api/marketplace/me';
const PROFILE_PATH = '/api/marketplace/me/profile';
const CREATOR_PATH = /^\/api\/marketplace\/creators\/([^/]+)$/;
const CREATOR_WORKS_PATH = /^\/api\/marketplace\/creators\/([^/]+)\/presets$/;
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

export interface MemberApiDependencies {
  members: MemberRepository;
  sessions: SessionVerifier;
  now(): Date;
  createId(): string;
  createHandleSuffix(): string;
  publicWorks?: PublicCreatorWorks;
}

export interface MemberApi {
  fetch(request: Request): Promise<Response>;
}

function error(status: number, code: string, message: string, extra = {}): Response {
  return Response.json({ error: { code, message, ...extra } }, { status });
}

function profile(member: MemberRecord): MemberProfile {
  const nextHandleChangeAt = member.handleChangedAt
    ? new Date(member.handleChangedAt.getTime() + HANDLE_CHANGE_INTERVAL_MS).toISOString()
    : null;
  return {
    id: member.id,
    handle: member.handle,
    displayName: member.displayName,
    bio: member.bio,
    avatarUrl: member.avatarUrl,
    handleChangedAt: member.handleChangedAt?.toISOString() ?? null,
    nextHandleChangeAt,
    createdAt: member.createdAt.toISOString(),
    updatedAt: member.updatedAt.toISOString(),
  };
}

function creator(member: MemberRecord): PublicCreatorProfile {
  return {
    id: member.id,
    handle: member.handle,
    displayName: member.displayName,
    bio: member.bio,
    avatarUrl: member.avatarUrl,
    publicWorksUrl: `/api/marketplace/creators/${encodeURIComponent(member.handle)}/presets`,
  };
}

function parseProfileUpdate(value: unknown): UpdateMemberProfileInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (
    !('expectedUpdatedAt' in input)
    || keys.every((key) => key === 'expectedUpdatedAt')
    || keys.some((key) => !['handle', 'displayName', 'bio', 'expectedUpdatedAt'].includes(key))
  ) {
    return null;
  }
  if (
    typeof input.expectedUpdatedAt !== 'string'
    || !Number.isFinite(Date.parse(input.expectedUpdatedAt))
  ) return null;
  if ('handle' in input && (
    typeof input.handle !== 'string' || !HANDLE_PATTERN.test(input.handle)
  )) return null;
  if ('displayName' in input && (
    typeof input.displayName !== 'string'
    || input.displayName.trim().length < 1
    || input.displayName.trim().length > 80
  )) return null;
  if ('bio' in input && (typeof input.bio !== 'string' || input.bio.length > 500)) return null;
  return {
    ...('handle' in input ? { handle: input.handle as string } : {}),
    ...('displayName' in input ? { displayName: (input.displayName as string).trim() } : {}),
    ...('bio' in input ? { bio: input.bio as string } : {}),
    expectedUpdatedAt: new Date(input.expectedUpdatedAt),
  };
}

export function createMemberApi(dependencies: MemberApiDependencies): MemberApi {
  const currentMember = async (request: Request): Promise<MemberRecord | Response> => {
    const identity = await dependencies.sessions.verify(request);
    if (!identity) {
      return error(401, 'authentication_required', 'Authentication required');
    }
    return dependencies.members.findOrCreateForIdentity({
      id: dependencies.createId(),
      identity,
      handle: `player-${dependencies.createHandleSuffix()}`,
      now: dependencies.now(),
    });
  };

  return {
    async fetch(request) {
      const url = new URL(request.url);
      try {

      if (request.method === 'GET' && url.pathname === ME_PATH) {
        const member = await currentMember(request);
        return member instanceof Response ? member : Response.json({ member: profile(member) });
      }

      if (request.method === 'PATCH' && url.pathname === PROFILE_PATH) {
        const member = await currentMember(request);
        if (member instanceof Response) return member;
        const denied = communityWriteDenied(member);
        if (denied) return denied;
        let update: UpdateMemberProfileInput | null = null;
        try {
          update = parseProfileUpdate(await request.json());
        } catch {
          // The stable validation response below owns malformed JSON as well.
        }
        if (!update) return error(400, 'invalid_profile', 'Invalid profile');
        try {
          const updated = await dependencies.members.updateProfile(
            member.id,
            update,
            dependencies.now(),
          );
          return Response.json({ member: profile(updated) });
        } catch (cause) {
          if (cause instanceof HandleUnavailableError) {
            return error(409, 'handle_unavailable', 'Handle is unavailable');
          }
          if (cause instanceof HandleChangeTooSoonError) {
            return error(409, 'handle_change_too_soon', 'Handle cannot be changed yet', {
              nextHandleChangeAt: cause.nextHandleChangeAt.toISOString(),
            });
          }
          if (cause instanceof MemberUpdateConflictError) {
            return error(409, 'profile_update_conflict', 'Profile changed since it was loaded');
          }
          throw cause;
        }
      }

      const creatorMatch = request.method === 'GET' ? CREATOR_PATH.exec(url.pathname) : null;
      if (creatorMatch) {
        const resolution = await dependencies.members.resolveHandle(
          decodeURIComponent(creatorMatch[1]),
        );
        if (resolution.kind === 'missing') {
          return error(404, 'creator_not_found', 'Creator not found');
        }
        if (resolution.kind === 'redirect') {
          return new Response(null, {
            status: 308,
            headers: {
              location: `/api/marketplace/creators/${encodeURIComponent(resolution.member.handle)}`,
            },
          });
        }
        return Response.json({ creator: creator(resolution.member) });
      }

      const worksMatch = request.method === 'GET' ? CREATOR_WORKS_PATH.exec(url.pathname) : null;
      if (worksMatch && dependencies.publicWorks) {
        const requestedHandle = decodeURIComponent(worksMatch[1]);
        const resolution = await dependencies.members.resolveHandle(requestedHandle);
        if (resolution.kind === 'missing') {
          return error(404, 'creator_not_found', 'Creator not found');
        }
        if (resolution.kind === 'redirect') {
          return new Response(null, {
            status: 308,
            headers: {
              location: `/api/marketplace/creators/${encodeURIComponent(resolution.member.handle)}/presets`,
            },
          });
        }
        return Response.json({
          presets: await dependencies.publicWorks.listByCreatorId(resolution.member.id),
        });
      }

        return error(404, 'marketplace_route_not_found', 'Marketplace route not found');
      } catch {
        return error(503, 'member_service_unavailable', 'Member service is unavailable');
      }
    },
  };
}
