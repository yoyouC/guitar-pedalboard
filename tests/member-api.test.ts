import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemberApi } from '../server/members/api.ts';
import { createMemoryMemberRepository } from '../server/members/memoryRepository.ts';
import type { AuthenticatedIdentity, SessionVerifier } from '../server/auth/session.ts';

const now = new Date('2026-08-29T08:00:00.000Z');

function session(identity: AuthenticatedIdentity | null): SessionVerifier {
  return { async verify() { return identity; } };
}

const adaIdentity: AuthenticatedIdentity = {
  authUserId: 'auth-ada',
  email: 'ada@example.test',
  displayName: 'Ada Lovelace',
  avatarUrl: 'https://images.example.test/ada.png',
};

test('anonymous member API does not expose a current member', async () => {
  const api = createMemberApi({
    members: createMemoryMemberRepository(),
    sessions: session(null),
    now: () => now,
    createId: () => 'member-unused',
    createHandleSuffix: () => 'unused',
  });

  const response = await api.fetch(new Request('https://pedalboard.test/api/marketplace/me'));

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: { code: 'authentication_required', message: 'Authentication required' },
  });
});

test('a verified identity gets one stable member with an automatic handle and provider avatar', async () => {
  const members = createMemoryMemberRepository();
  const api = createMemberApi({
    members,
    sessions: session(adaIdentity),
    now: () => now,
    createId: () => 'member-ada',
    createHandleSuffix: () => '4f82a1',
  });

  const first = await api.fetch(new Request('https://pedalboard.test/api/marketplace/me'));
  const second = await api.fetch(new Request('https://pedalboard.test/api/marketplace/me'));

  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), {
    member: {
      id: 'member-ada',
      handle: 'player-4f82a1',
      displayName: 'Ada Lovelace',
      bio: '',
      avatarUrl: 'https://images.example.test/ada.png',
      handleChangedAt: null,
      nextHandleChangeAt: null,
      termsAcceptedVersion: null,
      readyForPublicAttribution: false,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
  });
  assert.equal((await second.json()).member.id, 'member-ada');
  assert.equal(await members.count(), 1);
});

test('member can edit public profile without accepting an arbitrary avatar upload URL', async () => {
  const api = createMemberApi({
    members: createMemoryMemberRepository(),
    sessions: session(adaIdentity),
    now: () => now,
    createId: () => 'member-ada',
    createHandleSuffix: () => '4f82a1',
  });
  await api.fetch(new Request('https://pedalboard.test/api/marketplace/me'));

  const response = await api.fetch(new Request('https://pedalboard.test/api/marketplace/me/profile', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      displayName: 'Ada L.',
      bio: 'Clean tones and impossible machines.',
      avatarUrl: 'https://attacker.test/payload.svg',
      expectedUpdatedAt: now.toISOString(),
    }),
  }));

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'invalid_profile');
});

test('public attribution becomes ready only after profile and current terms are submitted together', async () => {
  const api = createMemberApi({
    members: createMemoryMemberRepository(),
    sessions: session(adaIdentity),
    now: () => now,
    createId: () => 'member-ada',
    createHandleSuffix: () => '4f82a1',
  });
  const initial = (await (await api.fetch(
    new Request('https://pedalboard.test/api/marketplace/me'),
  )).json()).member;
  assert.equal(initial.readyForPublicAttribution, false);

  const incomplete = await api.fetch(profilePatch({ termsAcceptedVersion: '2026-08-29' }));
  assert.equal(incomplete.status, 400);

  const completed = await api.fetch(profilePatch({
    handle: 'ada-tones',
    displayName: 'Ada Lovelace',
    termsAcceptedVersion: '2026-08-29',
  }));
  const completedMember = (await completed.json()).member;
  assert.equal(completed.status, 200);
  assert.equal(completedMember.termsAcceptedVersion, '2026-08-29');
  assert.equal(completedMember.readyForPublicAttribution, true);
});

test('handle is unique, rate-limited for 90 days, and old handles redirect forever', async () => {
  const members = createMemoryMemberRepository([
    {
      id: 'member-grace',
      authUserId: 'auth-grace',
      handle: 'grace',
      displayName: 'Grace',
      bio: '',
      avatarUrl: null,
      handleChangedAt: null,
      termsAcceptedVersion: null,
      publicProfileCompletedAt: null,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  let currentTime = now;
  const api = createMemberApi({
    members,
    sessions: session(adaIdentity),
    now: () => currentTime,
    createId: () => 'member-ada',
    createHandleSuffix: () => '4f82a1',
  });
  await api.fetch(new Request('https://pedalboard.test/api/marketplace/me'));

  const conflict = await api.fetch(profilePatch({ handle: 'grace' }));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'handle_unavailable');

  const changed = await api.fetch(profilePatch({ handle: 'ada-tones' }));
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).member.handle, 'ada-tones');

  const tooSoon = await api.fetch(profilePatch({ handle: 'ada-rigs' }));
  assert.equal(tooSoon.status, 409);
  const tooSoonBody = await tooSoon.json();
  assert.equal(tooSoonBody.error.code, 'handle_change_too_soon');
  assert.equal(tooSoonBody.error.nextHandleChangeAt, '2026-11-27T08:00:00.000Z');

  const oldHandle = await api.fetch(
    new Request('https://pedalboard.test/api/marketplace/creators/player-4f82a1'),
  );
  assert.equal(oldHandle.status, 308);
  assert.equal(oldHandle.headers.get('location'), '/api/marketplace/creators/ada-tones');

  currentTime = new Date('2026-11-27T08:00:00.000Z');
  const changedAgain = await api.fetch(profilePatch({ handle: 'ada-rigs' }));
  assert.equal(changedAgain.status, 200);

  const stableId = await api.fetch(
    new Request('https://pedalboard.test/api/marketplace/creators/id/member-ada'),
  );
  assert.equal(stableId.status, 200);
  assert.deepEqual((await stableId.json()).creator, {
    id: 'member-ada',
    handle: 'ada-rigs',
    displayName: 'Ada Lovelace',
    bio: '',
    avatarUrl: 'https://images.example.test/ada.png',
    publicWorksUrl: '/api/marketplace/creators/id/member-ada/presets',
  });

  const reclaimed = await api.fetch(profilePatch({
    handle: 'player-4f82a1',
    expectedUpdatedAt: currentTime.toISOString(),
  }));
  assert.equal(reclaimed.status, 409);
  assert.equal((await reclaimed.json()).error.code, 'handle_unavailable');
});

test('public creator profile has a strict privacy boundary', async () => {
  const members = createMemoryMemberRepository();
  const api = createMemberApi({
    members,
    sessions: session(adaIdentity),
    now: () => now,
    createId: () => 'member-ada',
    createHandleSuffix: () => '4f82a1',
    publicWorks: {
      async listByCreatorId() {
        return [{
          id: 'preset-clean',
          title: 'Ada Clean',
          url: '/marketplace/presets/preset-clean',
        }];
      },
    },
  });
  await api.fetch(new Request('https://pedalboard.test/api/marketplace/me'));

  const response = await api.fetch(
    new Request('https://pedalboard.test/api/marketplace/creators/player-4f82a1'),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    creator: {
      id: 'member-ada',
      handle: 'player-4f82a1',
      displayName: 'Ada Lovelace',
      bio: '',
      avatarUrl: 'https://images.example.test/ada.png',
      publicWorksUrl: '/api/marketplace/creators/player-4f82a1/presets',
    },
  });
  assert.equal(JSON.stringify(body).includes('ada@example.test'), false);
  assert.equal(JSON.stringify(body).includes('auth-ada'), false);
  assert.equal(JSON.stringify(body).includes('token'), false);

  const works = await api.fetch(
    new Request('https://pedalboard.test/api/marketplace/creators/player-4f82a1/presets'),
  );
  assert.equal(works.status, 200);
  assert.deepEqual(await works.json(), {
    presets: [{
      id: 'preset-clean',
      title: 'Ada Clean',
      url: '/marketplace/presets/preset-clean',
    }],
  });
});

test('profile update rejects a stale optimistic concurrency token', async () => {
  const api = createMemberApi({
    members: createMemoryMemberRepository(),
    sessions: session(adaIdentity),
    now: () => now,
    createId: () => 'member-ada',
    createHandleSuffix: () => '4f82a1',
  });
  await api.fetch(new Request('https://pedalboard.test/api/marketplace/me'));

  const response = await api.fetch(profilePatch({
    displayName: 'Stale overwrite',
    expectedUpdatedAt: '2026-08-28T00:00:00.000Z',
  }));

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'profile_update_conflict');
});

test('banned member keeps read access but cannot update the community profile', async () => {
  const members = createMemoryMemberRepository([{
    id: 'member-ada',
    authUserId: adaIdentity.authUserId,
    handle: 'ada',
    displayName: 'Ada',
    bio: '',
    avatarUrl: null,
    handleChangedAt: null,
    createdAt: now,
    updatedAt: now,
    communityStatus: 'banned',
  }]);
  const api = createMemberApi({
    members,
    sessions: session(adaIdentity),
    now: () => now,
    createId: () => 'member-unused',
    createHandleSuffix: () => 'unused',
  });

  assert.equal((await api.fetch(new Request('https://pedalboard.test/api/marketplace/me'))).status, 200);
  const response = await api.fetch(profilePatch({ displayName: 'Still Ada' }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'member_banned');
});

test('member fact-source failure becomes a stable unavailable response', async () => {
  const members = createMemoryMemberRepository();
  members.resolveHandle = async () => { throw new Error('database offline'); };
  const api = createMemberApi({
    members,
    sessions: session(null),
    now: () => now,
    createId: () => 'unused',
    createHandleSuffix: () => 'unused',
  });

  const response = await api.fetch(
    new Request('https://pedalboard.test/api/marketplace/creators/missing'),
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: { code: 'member_service_unavailable', message: 'Member service is unavailable' },
  });
});

function profilePatch(body: Record<string, unknown>): Request {
  return new Request('https://pedalboard.test/api/marketplace/me/profile', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedUpdatedAt: now.toISOString(), ...body }),
  });
}
