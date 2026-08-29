import assert from 'node:assert/strict';
import test from 'node:test';
import { safeLoginReturnPath, loginReturnFromSearch } from '../src/app/loginReturn.ts';
import { loadAppPreferences, saveAppPreferences } from '../src/app/preferences.ts';
import { createMemberSession } from '../src/members/session.ts';
import { readFile } from 'node:fs/promises';

const member = {
  id: 'member-ada',
  handle: 'ada-tones',
  displayName: 'Ada',
  bio: '',
  avatarUrl: null,
  handleChangedAt: null,
  nextHandleChangeAt: null,
  termsAcceptedVersion: '2026-08-29',
  readyForPublicAttribution: true,
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
};

test('login return paths accept only same-site relative destinations', () => {
  assert.equal(safeLoginReturnPath('/marketplace/search?q=clean#rig'), '/marketplace/search?q=clean#rig');
  assert.equal(loginReturnFromSearch('?return=%2Fsettings%23account'), '/settings#account');
  assert.equal(safeLoginReturnPath('https://attacker.test/steal'), '/');
  assert.equal(safeLoginReturnPath('//attacker.test/steal'), '/');
  assert.equal(safeLoginReturnPath('/\\attacker.test/steal'), '/');
  assert.equal(safeLoginReturnPath('/login?return=%2Flogin'), '/');
});

test('one global member session survives route consumers and distinguishes outages', async () => {
  let mode: 'member' | 'anonymous' | 'offline' = 'member';
  const session = createMemberSession(async () => {
    if (mode === 'member') return Response.json({ member });
    if (mode === 'anonymous') return Response.json({ error: {} }, { status: 401 });
    return Response.json({ error: {} }, { status: 503 });
  });
  let notifications = 0;
  session.subscribe(() => { notifications += 1; });

  assert.equal((await session.load()).status, 'authenticated');
  assert.equal(session.getState().status, 'authenticated');
  mode = 'anonymous';
  assert.equal((await session.refresh()).status, 'anonymous');
  mode = 'offline';
  assert.equal((await session.refresh()).status, 'unavailable');
  assert.ok(notifications >= 5);
});

test('appearance and locale preferences round-trip as one versioned record', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
  };
  const preferences = {
    locale: 'zh-CN' as const,
    background: 'prism' as const,
    reduceVisualLoad: true,
    reducedMotion: true,
  };
  saveAppPreferences(preferences, storage);
  assert.deepEqual(loadAppPreferences(storage), preferences);
});

test('account handle pattern escapes the hyphen for modern HTML unicode-v validation', async () => {
  const source = await readFile(
    new URL('../src/components/SettingsPage.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /a-z0-9\\-/);
});
