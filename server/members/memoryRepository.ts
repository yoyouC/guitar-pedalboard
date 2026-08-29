import type {
  CreateMemberInput,
  HandleResolution,
  MemberRecord,
  MemberRepository,
  UpdateMemberProfileInput,
} from './repository.ts';
import {
  HANDLE_CHANGE_INTERVAL_MS,
  HandleChangeTooSoonError,
  HandleUnavailableError,
  MemberUpdateConflictError,
} from './repository.ts';

export function createMemoryMemberRepository(
  initialMembers: readonly MemberRecord[] = [],
): MemberRepository & {
  count(): Promise<number>;
  listForDiscovery(): Promise<MemberRecord[]>;
  setCommunityStatus(memberId: string, status: 'active' | 'banned'): Promise<void>;
} {
  const membersById = new Map(initialMembers.map((member) => [member.id, { ...member }]));
  const memberIdsByAuthUserId = new Map(
    initialMembers.flatMap((member) => member.authUserId ? [[member.authUserId, member.id]] : []),
  );
  const handleOwners = new Map(initialMembers.map((member) => [member.handle, member.id]));

  function currentMember(memberId: string): MemberRecord {
    const member = membersById.get(memberId);
    if (!member) throw new Error('Member not found');
    return member;
  }

  return {
    async findById(memberId) {
      const member = membersById.get(memberId);
      return member ? { ...member } : null;
    },

    async findOrCreateForIdentity({ id, identity, handle, now }: CreateMemberInput) {
      const existingId = memberIdsByAuthUserId.get(identity.authUserId);
      if (existingId) return { ...currentMember(existingId) };
      if (handleOwners.has(handle)) throw new HandleUnavailableError();

      const member: MemberRecord = {
        id,
        authUserId: identity.authUserId,
        handle,
        displayName: identity.displayName,
        bio: '',
        avatarUrl: identity.avatarUrl,
        handleChangedAt: null,
        createdAt: now,
        updatedAt: now,
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
      return { kind: member.handle === handle ? 'current' : 'redirect', member };
    },

    async updateProfile(memberId, update: UpdateMemberProfileInput, now) {
      const current = currentMember(memberId);
      if (current.updatedAt.getTime() !== update.expectedUpdatedAt.getTime()) {
        throw new MemberUpdateConflictError();
      }
      if (update.handle && update.handle !== current.handle) {
        if (handleOwners.has(update.handle)) throw new HandleUnavailableError();
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
    async listForDiscovery() {
      return [...membersById.values()].map((member) => ({ ...member }));
    },
    async setCommunityStatus(memberId: string, communityStatus: 'active' | 'banned') {
      const member = currentMember(memberId);
      membersById.set(memberId, { ...member, communityStatus });
    },
  };
}
