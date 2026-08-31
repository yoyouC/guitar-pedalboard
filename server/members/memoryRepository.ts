import type {
  CreateMemberInput,
  HandleResolution,
  MemberRecord,
  MemberRepository,
  UpdateMemberProfileInput,
} from './repository.js';
import { assertCommunityWriteAllowed } from './standing.js';

async function handleDigest(handle: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(handle));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
import {
  HANDLE_CHANGE_INTERVAL_MS,
  HandleChangeTooSoonError,
  HandleUnavailableError,
  MemberUpdateConflictError,
} from './repository.js';

export function createMemoryMemberRepository(
  initialMembers: readonly MemberRecord[] = [],
  initialHandleClaims: readonly { handle: string; memberId: string }[] = [],
): MemberRepository & {
  count(): Promise<number>;
  findByAuthUserId(authUserId: string): Promise<MemberRecord | null>;
  listForDiscovery(): Promise<MemberRecord[]>;
  setCommunityStatus(memberId: string, status: 'active' | 'banned'): Promise<void>;
  setAccountStatus(
    memberId: string,
    status: 'active' | 'pending_deletion' | 'tombstoned',
    now: Date,
  ): Promise<void>;
  purgeAccount(memberId: string, now: Date): Promise<void>;
} {
  const membersById = new Map(initialMembers.map((member) => [member.id, { ...member }]));
  const memberIdsByAuthUserId = new Map(
    initialMembers.flatMap((member) => member.authUserId ? [[member.authUserId, member.id]] : []),
  );
  const handleOwners = new Map([
    ...initialMembers.map((member) => [member.handle, member.id] as const),
    ...initialHandleClaims.map((claim) => [claim.handle, claim.memberId] as const),
  ]);
  const reservedHandleDigests = new Set<string>();

  function currentMember(memberId: string): MemberRecord {
    const member = membersById.get(memberId);
    if (!member) throw new Error('Member not found');
    return member;
  }

  return {
    async findById(memberId) {
      const member = membersById.get(memberId);
      return member && member.accountStatus !== 'tombstoned' ? { ...member } : null;
    },

    async findOrCreateForIdentity({ id, identity, handle, now }: CreateMemberInput) {
      const existingId = memberIdsByAuthUserId.get(identity.authUserId);
      if (existingId) return { ...currentMember(existingId) };
      if (handleOwners.has(handle) || reservedHandleDigests.has(await handleDigest(handle))) {
        throw new HandleUnavailableError();
      }

      const member: MemberRecord = {
        id,
        authUserId: identity.authUserId,
        handle,
        displayName: identity.displayName,
        bio: '',
        avatarUrl: identity.avatarUrl,
        handleChangedAt: null,
        termsAcceptedVersion: null,
        publicProfileCompletedAt: null,
        createdAt: now,
        updatedAt: now,
        accountStatus: 'active',
      };
      membersById.set(id, member);
      memberIdsByAuthUserId.set(identity.authUserId, id);
      handleOwners.set(handle, id);
      return { ...member };
    },

    async resolveHandle(handle): Promise<HandleResolution> {
      const memberId = handleOwners.get(handle);
      if (!memberId) return { kind: 'missing' };
      const member = { ...currentMember(memberId) };
      if (member.accountStatus === 'tombstoned') return { kind: 'missing' };
      return { kind: member.handle === handle ? 'current' : 'redirect', member };
    },

    async updateProfile(memberId, update: UpdateMemberProfileInput, now) {
      const current = currentMember(memberId);
      assertCommunityWriteAllowed(current);
      if (current.updatedAt.getTime() !== update.expectedUpdatedAt.getTime()) {
        throw new MemberUpdateConflictError();
      }
      if (update.handle && update.handle !== current.handle) {
        if (
          handleOwners.has(update.handle)
          || reservedHandleDigests.has(await handleDigest(update.handle))
        ) throw new HandleUnavailableError();
        if (current.handleChangedAt) {
          const nextChangeAt = new Date(
            current.handleChangedAt.getTime() + HANDLE_CHANGE_INTERVAL_MS,
          );
          if (now < nextChangeAt) throw new HandleChangeTooSoonError(nextChangeAt);
        }
        handleOwners.set(update.handle, memberId);
      }

      const updated: MemberRecord = {
        ...current,
        handle: update.handle ?? current.handle,
        displayName: update.displayName ?? current.displayName,
        bio: update.bio ?? current.bio,
        termsAcceptedVersion: update.termsAcceptedVersion ?? current.termsAcceptedVersion,
        publicProfileCompletedAt: update.termsAcceptedVersion ? now : current.publicProfileCompletedAt,
        handleChangedAt:
          update.handle && update.handle !== current.handle ? now : current.handleChangedAt,
        updatedAt: now,
      };
      membersById.set(memberId, updated);
      return { ...updated };
    },

    async count() {
      return membersById.size;
    },
    async findByAuthUserId(authUserId: string) {
      const memberId = memberIdsByAuthUserId.get(authUserId);
      return memberId ? { ...currentMember(memberId) } : null;
    },
    async listForDiscovery() {
      return [...membersById.values()]
        .filter((member) => (member.accountStatus ?? 'active') === 'active')
        .map((member) => ({ ...member }));
    },
    async setCommunityStatus(memberId: string, communityStatus: 'active' | 'banned') {
      const member = currentMember(memberId);
      membersById.set(memberId, { ...member, communityStatus });
    },
    async setAccountStatus(memberId, accountStatus, now) {
      const member = currentMember(memberId);
      membersById.set(memberId, { ...member, accountStatus, updatedAt: now });
    },
    async purgeAccount(memberId, now) {
      const member = currentMember(memberId);
      const tombstoneHandle = `deleted-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
      for (const [handle, ownerId] of [...handleOwners]) {
        if (ownerId !== memberId) continue;
        reservedHandleDigests.add(await handleDigest(handle));
        handleOwners.delete(handle);
      }
      handleOwners.set(tombstoneHandle, memberId);
      if (member.authUserId) memberIdsByAuthUserId.delete(member.authUserId);
      membersById.set(memberId, {
        ...member,
        authUserId: null,
        handle: tombstoneHandle,
        displayName: 'Deleted member',
        bio: '',
        avatarUrl: null,
        handleChangedAt: null,
        accountStatus: 'tombstoned',
        updatedAt: now,
      });
    },
  };
}
