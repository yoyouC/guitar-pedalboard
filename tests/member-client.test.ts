import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MemberClientError,
  fetchCurrentMember,
  fetchPublicCreatorById,
  fetchPublicCreatorWorksById,
  requestMagicLink,
  updateMemberProfile,
} from '../src/members/client.ts';

const member = {
  id: 'member-ada',
  handle: 'ada-tones',
  displayName: 'Ada',
  bio: 'Clean rigs.',
  avatarUrl: null,
  handleChangedAt: null,
  nextHandleChangeAt: null,
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
};

test('member client distinguishes anonymous state from marketplace failure', async () => {
  await assert.rejects(
    fetchCurrentMember(async () => Response.json({ error: {} }, { status: 401 })),
    (cause) => cause instanceof MemberClientError && cause.code === 'authentication_required',
  );
  await assert.rejects(
    fetchCurrentMember(async () => Response.json({ error: {} }, { status: 503 })),
    (cause) => cause instanceof MemberClientError && cause.code === 'member_service_unavailable',
  );
});

test('creator client loads canonical member-id pages without relying on the current handle', async () => {
  const calls: string[] = [];
  const fetch = async (input: RequestInfo | URL) => {
    calls.push(String(input));
    if (String(input).endsWith('/presets')) {
      return Response.json({ presets: [{
        id: 'preset-clean', title: 'Ada Clean', url: '/marketplace/presets/preset-clean',
      }] });
    }
    return Response.json({ creator: {
      id: 'member-ada', handle: 'ada-new', displayName: 'Ada', bio: 'Clean rigs.',
      avatarUrl: null, publicWorksUrl: '/api/marketplace/creators/id/member-ada/presets',
    } });
  };

  assert.equal((await fetchPublicCreatorById('member-ada', fetch)).handle, 'ada-new');
  assert.equal((await fetchPublicCreatorWorksById('member-ada', fetch))[0].id, 'preset-clean');
  assert.deepEqual(calls, [
    '/api/marketplace/creators/id/member-ada',
    '/api/marketplace/creators/id/member-ada/presets',
  ]);
});

test('member client rejects private or malformed fields crossing the profile seam', async () => {
  await assert.rejects(
    fetchCurrentMember(async () => Response.json({ member: { ...member, email: 'private@test' } })),
    (cause) => cause instanceof MemberClientError && cause.code === 'invalid_member_response',
  );
});

test('magic link and profile updates use stable same-origin endpoints', async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    if (String(input).includes('magic-link')) return Response.json({ status: true });
    return Response.json({ member });
  };

  await requestMagicLink('ada@example.test', '/', fetch);
  const updated = await updateMemberProfile({
    displayName: 'Ada',
    bio: 'Clean rigs.',
    expectedUpdatedAt: member.updatedAt,
  }, fetch);

  assert.deepEqual(updated, member);
  assert.equal(calls[0].input, '/api/auth/sign-in/magic-link');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    email: 'ada@example.test',
    callbackURL: '/',
  });
  assert.equal(calls[1].input, '/api/marketplace/me/profile');
  assert.equal(calls[1].init?.method, 'PATCH');
});
