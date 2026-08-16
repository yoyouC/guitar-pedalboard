import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModelText, setTone3000ModelTextProvider } from '../src/audio/namWasm.ts';

/**
 * namWasm 模型源分派(ADR-0007):tone3000: 源经注册的 provider 下载;
 * 失败不缓存(登录后重试不命中缓存的 rejection)。
 */

test.afterEach(() => setTone3000ModelTextProvider(null));

test('tone3000: 源经注册 provider 按 toneId 下载并缓存', async () => {
  const seen: string[] = [];
  setTone3000ModelTextProvider(async (toneId) => {
    seen.push(toneId);
    return '{"metadata":{"name":"T3K"}}';
  });
  const a = await loadModelText('tone3000:79103');
  const b = await loadModelText('tone3000:79103');
  assert.equal(a, b);
  assert.deepEqual(seen, ['79103']); // 第二次命中缓存
});

test('未注册 provider:tone3000: 源拒绝,且失败不缓存(注册后重试成功)', async () => {
  await assert.rejects(loadModelText('tone3000:1'), /未注册/);
  setTone3000ModelTextProvider(async () => '{"ok":true}');
  assert.equal(await loadModelText('tone3000:1'), '{"ok":true}');
});

test('provider 失败不缓存:登录后重试成功', async () => {
  let authed = false;
  setTone3000ModelTextProvider(async () => {
    if (!authed) throw new Error('not-authenticated');
    return '{"after":"login"}';
  });
  await assert.rejects(loadModelText('tone3000:2'), /not-authenticated/);
  authed = true;
  assert.equal(await loadModelText('tone3000:2'), '{"after":"login"}');
});
