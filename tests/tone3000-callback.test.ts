import assert from 'node:assert/strict';
import test from 'node:test';
import {
  maybeHandleOAuthCallback,
  stashReturnRig,
  popReturnRig,
} from '../src/tone3000/callback.ts';

/** OAuth 回调启动处理:URL 判定、客户端分派、return-rig stash。 */

const REDIRECT = 'http://localhost:5173/tone3000/callback';

function fakeClient(result: unknown) {
  const calls: string[] = [];
  return {
    calls,
    handleCallback: async (url: string) => {
      calls.push(url);
      return result;
    },
  };
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

test('非回调 URL 不处理(普通路由/无参数)', async () => {
  const client = fakeClient({ ok: true, tokens: {}, toneId: '1' });
  assert.deepEqual(await maybeHandleOAuthCallback('http://localhost:5173/', client), { handled: false });
  assert.deepEqual(
    await maybeHandleOAuthCallback(`${REDIRECT}`, client),
    { handled: false },
  );
  assert.equal(client.calls.length, 0);
});

test('回调 URL:分派客户端,成功返回 toneId 并清 URL 参数', async () => {
  const client = fakeClient({ ok: true, tokens: {}, toneId: '79103' });
  const url = `${REDIRECT}?code=C&state=S&tone_id=79103`;
  const outcome = await maybeHandleOAuthCallback(url, client);
  assert.deepEqual(outcome, { handled: true, toneId: '79103' });
  assert.equal(client.calls.length, 1);
});

test('回调失败(state_mismatch/access_denied):handled 且带 error', async () => {
  const client = fakeClient({ ok: false, error: 'access_denied' });
  const outcome = await maybeHandleOAuthCallback(`${REDIRECT}?error=access_denied&state=S`, client);
  assert.deepEqual(outcome, { handled: true, error: 'access_denied' });
});

test('return-rig stash:写入→取出→取出后清除', () => {
  const storage = memoryStorage();
  stashReturnRig('ENCODED_RIG', storage);
  assert.equal(popReturnRig(storage), 'ENCODED_RIG');
  assert.equal(popReturnRig(storage), null);
});
