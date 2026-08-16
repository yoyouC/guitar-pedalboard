import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearTone3000ModelTextCache,
  loadModelText,
  setTone3000ModelTextProvider,
} from '../src/audio/namWasm.ts';

/**
 * namWasm 模型源分派(ADR-0007):tone3000: 源经注册的 provider 下载;
 * 失败不缓存(登录后重试不命中缓存的 rejection)。
 */

test.afterEach(() => {
  setTone3000ModelTextProvider(null);
  clearTone3000ModelTextCache();
});

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

test('Tone3000 模型缓存区分 exact modelId，并按最近使用限制为八条', async () => {
  const seen: string[] = [];
  setTone3000ModelTextProvider(async (toneId, modelId) => {
    seen.push(`${toneId}:${modelId ?? '-'}`);
    return `{${toneId}:${modelId ?? '-'}}`;
  });
  await loadModelText('tone3000:1', 'a');
  await loadModelText('tone3000:1', 'b');
  for (let i = 2; i <= 8; i++) await loadModelText(`tone3000:${i}`);
  assert.equal(seen.length, 9);
  await loadModelText('tone3000:1', 'a');
  assert.equal(seen.length, 10, '最旧 exact variant 已淘汰并重新下载');
});

test('Tone3000 provider 的生产共享队列最多并发两个真实下载', async () => {
  let active = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  setTone3000ModelTextProvider(async (toneId) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
    return toneId;
  });

  const pending = Promise.all([
    loadModelText('tone3000:101'),
    loadModelText('tone3000:102'),
    loadModelText('tone3000:103'),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(releases.length, 2);
  releases.shift()!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(releases.length, 2);
  while (releases.length) releases.shift()!();
  await pending;
  assert.equal(peak, 2);
});
