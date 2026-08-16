import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNamMetadata } from '../src/audio/namWasm.ts';

/** .nam 元数据解析:A2 SlimmableContainer 的 loudness 在子模型里(调研:docs/nam-a2-vs-a1.md) */

test('A1:顶层 metadata.loudness/name 直接读取', () => {
  const meta = parseNamMetadata(
    JSON.stringify({ metadata: { name: 'A1 Amp', loudness: -20.5 } }),
  );
  assert.equal(meta.displayName, 'A1 Amp');
  assert.equal(meta.loudness, -20.5);
});

test('A2 SlimmableContainer:顶层无 metadata → 回退最后一个(全尺寸)子模型', () => {
  const meta = parseNamMetadata(
    JSON.stringify({
      version: '0.7.0',
      architecture: 'SlimmableContainer',
      config: {
        submodels: [
          { max_value: 0.5, metadata: { name: 'A2 Lite', loudness: -22 } },
          { metadata: { name: 'A2 Full', loudness: -14.2 } },
        ],
      },
    }),
  );
  assert.equal(meta.displayName, 'A2 Full');
  assert.equal(meta.loudness, -14.2);
});

test('A2 顶层有 metadata 时优先顶层(不回退)', () => {
  const meta = parseNamMetadata(
    JSON.stringify({
      metadata: { name: 'Top', loudness: -18 },
      config: { submodels: [{ metadata: { name: 'Sub', loudness: -10 } }] },
    }),
  );
  assert.equal(meta.displayName, 'Top');
  assert.equal(meta.loudness, -18);
});

test('全无 metadata:回退未命名 + loudness null(不补偿)', () => {
  const meta = parseNamMetadata('{"architecture":"WaveNet","config":{}}');
  assert.equal(meta.displayName, '未命名模型');
  assert.equal(meta.loudness, null);
});
