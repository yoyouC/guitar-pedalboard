import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('deployment permanently redirects legacy Preset and search URLs to canonical Tone URLs', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.redirects, [
    {
      source: '/marketplace/presets/:id/revisions/:revisionId',
      destination: '/marketplace/tones/:id/revisions/:revisionId',
      permanent: true,
    },
    {
      source: '/marketplace/presets/:id',
      destination: '/marketplace/tones/:id',
      permanent: true,
    },
    {
      source: '/marketplace/search',
      destination: '/marketplace',
      permanent: true,
    },
  ]);
});
