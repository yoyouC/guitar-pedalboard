import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryMarketplaceAccountRepository } from '../server/accounts/memoryRepository.ts';
import { ACCOUNT_DELETION_GRACE_MS } from '../server/accounts/repository.ts';
import { createMemoryPresetCollectionRepository } from '../server/collections/memoryRepository.ts';
import { createMemoryMarketplaceLikeRepository } from '../server/likes/memoryRepository.ts';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import { createMemoryPublishedPresetRepository } from '../server/marketplace/memoryRepository.ts';
import { createMemoryMemberRepository } from '../server/members/memoryRepository.ts';
import { HandleUnavailableError } from '../server/members/repository.ts';
import type { PresetCollection, PublishedPreset } from '../shared/marketplace.ts';

test('Vite memory adapters export, withdraw, recover, and irreversibly scrub account data', async () => {
  const startedAt = new Date('2026-08-29T12:00:00.000Z');
  const ownerId = demoPublishedPreset.creator.id;
  const ownerAuthId = 'auth-memory-owner';
  const ownerPreset: PublishedPreset = structuredClone(demoPublishedPreset);
  const otherPreset: PublishedPreset = {
    ...structuredClone(demoPublishedPreset),
    id: 'preset-memory-other',
    creator: { id: 'member-memory-other', handle: 'other-memory', displayName: 'Other' },
    currentRevision: {
      ...structuredClone(demoPublishedPreset.currentRevision), id: 'revision-memory-other-1',
    },
  };
  const ownerCollection: PresetCollection = {
    id: 'collection-memory-owner',
    title: 'Owner collection body',
    description: 'Private export content',
    visibility: 'public',
    creator: ownerPreset.creator,
    tags: ownerPreset.tags,
    items: [],
    createdAt: ownerPreset.createdAt,
    updatedAt: ownerPreset.updatedAt,
  };
  const members = createMemoryMemberRepository([{
    id: ownerId,
    authUserId: ownerAuthId,
    handle: ownerPreset.creator.handle,
    displayName: ownerPreset.creator.displayName,
    bio: 'Owner bio',
    avatarUrl: 'https://example.test/avatar.png',
    handleChangedAt: null,
    createdAt: startedAt,
    updatedAt: startedAt,
    accountStatus: 'active',
  }]);
  const publications = createMemoryPublishedPresetRepository(
    [ownerPreset, otherPreset], ownerPreset.tags,
  );
  const collections = createMemoryPresetCollectionRepository(
    [ownerCollection], publications, ownerPreset.tags,
  );
  const likes = createMemoryMarketplaceLikeRepository({
    presets: [ownerPreset, otherPreset], collections: [ownerCollection],
  });
  await likes.setLiked({
    kind: 'preset', targetId: otherPreset.id, memberId: ownerId, liked: true, now: startedAt,
  });
  await likes.setLiked({
    kind: 'preset', targetId: ownerPreset.id, memberId: otherPreset.creator.id,
    liked: true, now: startedAt,
  });
  let authRevoked = false;
  const repository = createMemoryMarketplaceAccountRepository({
    members,
    emailForAuthUserId: () => 'owner-memory@example.test',
    lifecycle: {
      async exportData(memberId) {
        const [presets, collectionExports, relationships] = await Promise.all([
          publications.exportForAccount(memberId),
          collections.exportForAccount(memberId),
          likes.exportForAccount(memberId),
        ]);
        return {
          presets,
          collections: collectionExports,
          relationships: {
            ...relationships, moderationReports: [], moderationAppeals: [],
          },
        };
      },
      async withdraw(memberId, now) {
        const snapshot = {
          presets: await publications.withdrawForAccountDeletion(memberId, now),
          collections: await collections.withdrawForAccountDeletion(memberId, now),
        };
        for (const presetId of Object.keys(snapshot.presets)) {
          await likes.setAccountTargetVisibility('preset', presetId, 'withdrawn');
        }
        for (const collectionId of Object.keys(snapshot.collections)) {
          await likes.setAccountTargetVisibility('collection', collectionId, 'withdrawn');
        }
        return snapshot;
      },
      async restore(memberId, snapshot, now) {
        const saved = snapshot as {
          presets: Awaited<ReturnType<typeof publications.withdrawForAccountDeletion>>;
          collections: Awaited<ReturnType<typeof collections.withdrawForAccountDeletion>>;
        };
        await publications.restoreForAccountDeletion(memberId, saved.presets, now);
        await collections.restoreForAccountDeletion(memberId, saved.collections, now);
        for (const [presetId, visibility] of Object.entries(saved.presets)) {
          await likes.setAccountTargetVisibility('preset', presetId, visibility);
        }
        for (const [collectionId, visibility] of Object.entries(saved.collections)) {
          await likes.setAccountTargetVisibility('collection', collectionId, visibility);
        }
      },
      async purge(memberId, now) {
        await likes.purgeAccount(memberId);
        await publications.purgeAccount(memberId, now);
        await collections.purgeAccount(memberId, now);
      },
      async revokeAuth() { authRevoked = true; },
    },
  });

  const exported = await repository.exportByAuthUserId(ownerAuthId, startedAt);
  assert.deepEqual(exported?.presets.map((preset) => preset.id), [ownerPreset.id]);
  assert.deepEqual(exported?.collections.map((collection) => collection.id), [ownerCollection.id]);
  assert.deepEqual(exported?.relationships.presetLikes, [{
    presetId: otherPreset.id, createdAt: startedAt.toISOString(),
  }]);

  await repository.requestDeletion(ownerAuthId, startedAt);
  assert.equal(authRevoked, true);
  assert.equal(await publications.findVisibleById(ownerPreset.id), null);
  assert.equal(await collections.findVisibleById(ownerCollection.id), null);
  await assert.rejects(likes.getState('preset', ownerPreset.id, null));

  const recoveredAt = new Date(startedAt.getTime() + 24 * 60 * 60 * 1000);
  await repository.recoverDeletion(ownerAuthId, recoveredAt);
  assert.equal((await publications.findVisibleById(ownerPreset.id))?.visibility, 'public');
  assert.equal((await collections.findVisibleById(ownerCollection.id))?.visibility, 'public');

  await repository.requestDeletion(ownerAuthId, recoveredAt);
  const purgedAt = new Date(recoveredAt.getTime() + ACCOUNT_DELETION_GRACE_MS);
  assert.deepEqual(await repository.purgeDue(purgedAt), [ownerId]);
  assert.equal(await members.findById(ownerId), null);
  assert.deepEqual(await members.resolveHandle(ownerPreset.creator.handle), { kind: 'missing' });
  const replacement = await members.findOrCreateForIdentity({
    id: 'member-memory-replacement',
    identity: {
      authUserId: 'auth-memory-replacement',
      email: 'replacement@example.test',
      displayName: 'Replacement',
      avatarUrl: null,
    },
    handle: 'replacement-member',
    now: purgedAt,
  });
  await assert.rejects(
    members.updateProfile(replacement.id, {
      handle: ownerPreset.creator.handle,
      expectedUpdatedAt: replacement.updatedAt,
    }, purgedAt),
    HandleUnavailableError,
  );
  assert.equal(await repository.exportByAuthUserId(ownerAuthId, purgedAt), null);
  assert.equal((await likes.getState('preset', otherPreset.id, null)).likeCount, 0);
  const scrubbedPreset = (await publications.exportForAccount(ownerId))[0];
  assert.deepEqual({
    title: scrubbedPreset.title,
    description: scrubbedPreset.description,
    visibility: scrubbedPreset.visibility,
    tagIds: scrubbedPreset.tagIds,
    revisions: scrubbedPreset.revisions.map((revision) => ({
      rig: revision.rig,
      resourceDependencies: revision.resourceDependencies,
      derivedAttributes: revision.derivedAttributes,
    })),
  }, {
    title: 'Deleted preset',
    description: '',
    visibility: 'withdrawn',
    tagIds: [],
    revisions: [{ rig: {}, resourceDependencies: [], derivedAttributes: {} }],
  });
  const scrubbedCollection = (await collections.exportForAccount(ownerId))[0];
  assert.deepEqual({
    title: scrubbedCollection.title,
    description: scrubbedCollection.description,
    visibility: scrubbedCollection.visibility,
    tagIds: scrubbedCollection.tagIds,
    items: scrubbedCollection.items,
  }, {
    title: 'Deleted collection', description: '', visibility: 'withdrawn', tagIds: [], items: [],
  });
});
