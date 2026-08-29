import type { MemberRecord } from '../members/repository.ts';
import type { MarketplaceAccountExport } from '../../shared/account.ts';
import {
  ACCOUNT_DELETION_GRACE_MS,
  MarketplaceAccountDeletionNotPendingError,
  MarketplaceAccountNotFoundError,
  MarketplaceAccountRecoveryExpiredError,
  type MarketplaceAccountRepository,
} from './repository.ts';

interface MemoryAccountMembers {
  findByAuthUserId(authUserId: string): Promise<MemberRecord | null>;
  setAccountStatus(
    memberId: string,
    status: 'active' | 'pending_deletion' | 'tombstoned',
    now: Date,
  ): Promise<void>;
  purgeAccount(memberId: string, now: Date): Promise<void>;
}

export interface MemoryAccountLifecycle {
  exportData(memberId: string): Promise<Pick<
    MarketplaceAccountExport,
    'presets' | 'collections' | 'relationships'
  >>;
  withdraw(memberId: string, now: Date): Promise<unknown>;
  restore(memberId: string, snapshot: unknown, now: Date): Promise<void>;
  purge(memberId: string, now: Date): Promise<void>;
  revokeAuth(authUserId: string, email: string): Promise<void>;
}

export function createMemoryMarketplaceAccountRepository(input: {
  members: MemoryAccountMembers;
  emailForAuthUserId?(authUserId: string): string;
  lifecycle?: MemoryAccountLifecycle;
}): MarketplaceAccountRepository {
  const deletions = new Map<string, {
    requestedAt: Date; purgeAfter: Date; snapshot: unknown;
  }>();

  async function member(authUserId: string): Promise<MemberRecord> {
    const found = await input.members.findByAuthUserId(authUserId);
    if (!found || found.accountStatus === 'tombstoned') throw new MarketplaceAccountNotFoundError();
    return found;
  }

  return {
    async exportByAuthUserId(authUserId, now) {
      const current = await input.members.findByAuthUserId(authUserId);
      if (!current || current.accountStatus === 'tombstoned') return null;
      const lifecycleData = await input.lifecycle?.exportData(current.id);
      return {
        formatVersion: 1,
        exportedAt: now.toISOString(),
        account: {
          email: input.emailForAuthUserId?.(authUserId) ?? 'local-development@example.invalid',
        },
        member: {
          id: current.id,
          handle: current.handle,
          displayName: current.displayName,
          bio: current.bio,
          avatarUrl: current.avatarUrl,
          createdAt: current.createdAt.toISOString(),
          updatedAt: current.updatedAt.toISOString(),
        },
        presets: lifecycleData?.presets ?? [],
        collections: lifecycleData?.collections ?? [],
        relationships: lifecycleData?.relationships ?? {
          presetLikes: [], collectionLikes: [], moderationReports: [], moderationAppeals: [],
        },
      };
    },

    async findDeletion(authUserId) {
      const current = await input.members.findByAuthUserId(authUserId);
      if (!current || current.accountStatus === 'tombstoned') return null;
      const deletion = deletions.get(current.id);
      return deletion ? {
        status: 'pending',
        requestedAt: deletion.requestedAt.toISOString(),
        purgeAfter: deletion.purgeAfter.toISOString(),
      } : null;
    },

    async requestDeletion(authUserId, now) {
      const current = await member(authUserId);
      const existing = deletions.get(current.id);
      let deletion = existing;
      if (!deletion) {
        await input.members.setAccountStatus(current.id, 'pending_deletion', now);
        deletion = {
          requestedAt: now,
          purgeAfter: new Date(now.getTime() + ACCOUNT_DELETION_GRACE_MS),
          snapshot: await input.lifecycle?.withdraw(current.id, now),
        };
        deletions.set(current.id, deletion);
      }
      await input.lifecycle?.revokeAuth(
        authUserId,
        input.emailForAuthUserId?.(authUserId) ?? 'local-development@example.invalid',
      );
      return {
        status: 'pending',
        requestedAt: deletion.requestedAt.toISOString(),
        purgeAfter: deletion.purgeAfter.toISOString(),
      };
    },

    async recoverDeletion(authUserId, now) {
      const current = await member(authUserId);
      const deletion = deletions.get(current.id);
      if (!deletion) throw new MarketplaceAccountDeletionNotPendingError();
      if (deletion.purgeAfter <= now) throw new MarketplaceAccountRecoveryExpiredError();
      await input.lifecycle?.restore(current.id, deletion.snapshot, now);
      deletions.delete(current.id);
      await input.members.setAccountStatus(current.id, 'active', now);
    },

    async purgeDue(now) {
      const purged: string[] = [];
      for (const [memberId, deletion] of deletions) {
        if (deletion.purgeAfter > now) continue;
        await input.lifecycle?.purge(memberId, now);
        await input.members.purgeAccount(memberId, now);
        deletions.delete(memberId);
        purged.push(memberId);
      }
      return purged.sort();
    },
  };
}
