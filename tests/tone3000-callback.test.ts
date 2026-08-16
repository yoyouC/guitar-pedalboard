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

// ---------- boot 编排与元数据缓存 ----------

test('handleOAuthCallbackBoot: 恢复暂存 rig → 装载 tone → onSettled(顺序保证)', async () => {
  const order: string[] = [];
  const storage = memoryStorage();
  stashReturnRig('ENCODED_RIG', storage);
  const client = {
    handleCallback: async () => ({ ok: true as const, toneId: '79103' }),
  };
  const { handleOAuthCallbackBoot } = await import('../src/tone3000/callback.ts');
  const handled = await handleOAuthCallbackBoot(
    'http://localhost:5173/tone3000/callback?code=C&state=S',
    {
      client,
      storage,
      applyShareRig: (encoded) => order.push(`rig:${encoded}`),
      applyTone: (toneId) => order.push(`tone:${toneId}`),
      onSettled: () => order.push('settled'),
      onError: (e) => order.push(`error:${e}`),
    },
  );
  assert.equal(handled, true);
  assert.deepEqual(order, ['rig:ENCODED_RIG', 'tone:79103', 'settled']);
  assert.equal(popReturnRig(storage), null); // stash 已一次性清除
});

test('handleOAuthCallbackBoot: 非回调 URL 不动任何依赖', async () => {
  const order: string[] = [];
  const { handleOAuthCallbackBoot } = await import('../src/tone3000/callback.ts');
  const handled = await handleOAuthCallbackBoot('http://localhost:5173/', {
    client: { handleCallback: async () => ({ ok: true as const }) },
    storage: memoryStorage(),
    applyShareRig: () => order.push('rig'),
    applyTone: () => order.push('tone'),
    onSettled: () => order.push('settled'),
    onError: () => order.push('error'),
  });
  assert.equal(handled, false);
  assert.deepEqual(order, []);
});

test('handleOAuthCallbackBoot: 回调失败走 onError 且仍 onSettled', async () => {
  const order: string[] = [];
  const { handleOAuthCallbackBoot } = await import('../src/tone3000/callback.ts');
  await handleOAuthCallbackBoot(
    'http://localhost:5173/tone3000/callback?error=access_denied&state=S',
    {
      client: { handleCallback: async () => ({ ok: false as const, error: 'access_denied' }) },
      storage: memoryStorage(),
      applyShareRig: () => order.push('rig'),
      applyTone: () => order.push('tone'),
      onSettled: () => order.push('settled'),
      onError: (e) => order.push(`error:${e}`),
    },
  );
  assert.deepEqual(order, ['error:access_denied', 'settled']);
});

test('toneInfoCache: 写入→读取→超限淘汰最旧', async () => {
  const { getCachedToneInfo, putCachedToneInfo } = await import('../src/tone3000/toneInfoCache.ts');
  const storage = memoryStorage();
  const info = {
    id: 79103,
    title: 'Dual Rectifier',
    username: 'someone',
    license: 't3k',
    url: 'https://www.tone3000.com/tones/x-79103',
  };
  assert.equal(getCachedToneInfo('79103', storage), null);
  putCachedToneInfo(info, storage);
  assert.deepEqual(getCachedToneInfo('79103', storage), info);
  for (let i = 0; i < 60; i++) putCachedToneInfo({ ...info, id: 1000 + i }, storage);
  assert.equal(getCachedToneInfo('79103', storage), null); // 最旧的已被淘汰
  assert.ok(getCachedToneInfo('1059', storage));
});
