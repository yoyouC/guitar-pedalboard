import assert from 'node:assert/strict';
import test from 'node:test';
import { createStubAudioContext } from './helpers/stub-audio-context.ts';
import { createWorkletLoader } from '../src/audio/workletLoader.ts';

const SOURCE = "registerProcessor('stub-processor', class {});";

test('load(ctx) 每个 context 只注册一次', async (t) => {
  const ctx = createStubAudioContext();
  const load = createWorkletLoader(SOURCE);

  await load(ctx);
  await load(ctx);
  await load(ctx);

  assert.equal(ctx.audioWorklet.addedModules.length, 1);
  assert.ok(ctx.audioWorklet.addedModules[0].startsWith('blob:'));

  // addModule 成功后 URL 被 revoke(用 mock 观察)
  const ctx2 = createStubAudioContext();
  const load2 = createWorkletLoader(SOURCE);
  const revoked: string[] = [];
  const origRevoke = URL.revokeObjectURL;
  t.mock.method(URL, 'revokeObjectURL', (url: string) => {
    revoked.push(url);
    origRevoke.call(URL, url);
  });
  await load2(ctx2);
  assert.deepEqual(revoked, [ctx2.audioWorklet.addedModules[0]]);
});

test('load(ctx) 在第二个 context 上重新注册', async () => {
  const load = createWorkletLoader(SOURCE);
  const ctxA = createStubAudioContext();
  const ctxB = createStubAudioContext();

  await load(ctxA);
  await load(ctxA);
  await load(ctxB);

  assert.equal(ctxA.audioWorklet.addedModules.length, 1);
  assert.equal(ctxB.audioWorklet.addedModules.length, 1);
});

test('addModule 失败:错误向外传播,且该 context 未标记已加载(可重试)', async () => {
  const load = createWorkletLoader(SOURCE);
  const ctx = createStubAudioContext();
  const boom = new Error('addModule boom');
  ctx.audioWorklet.addModule = () => Promise.reject(boom);

  await assert.rejects(load(ctx), boom);
  await assert.rejects(load(ctx), boom);

  // 恢复后重试成功并注册(原型方法即 stub 的记录版 addModule)
  delete (ctx.audioWorklet as { addModule?: unknown }).addModule;
  await load(ctx);
  assert.equal(ctx.audioWorklet.addedModules.length, 1);
});

test('异步 source provider(NAM fetch+shim 变体):每次注册前取源,失败同样传播', async () => {
  let calls = 0;
  const load = createWorkletLoader(async () => {
    calls++;
    if (calls === 1) throw new Error('fetch boom');
    return `source-${calls}`;
  });
  const ctx = createStubAudioContext();

  await assert.rejects(load(ctx), /fetch boom/);
  await load(ctx);
  await load(ctx);
  assert.equal(calls, 2, '成功后幂等,不再取源');
  assert.equal(ctx.audioWorklet.addedModules.length, 1);
});
