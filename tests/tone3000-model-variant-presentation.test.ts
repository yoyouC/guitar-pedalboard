import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterTone3000ModelVariants,
  orderTone3000ModelVariantArchitectures,
  tone3000ModelVariantLabel,
  tone3000ModelSizeLabel,
} from '../src/tone3000/modelVariantPresentation.ts';
import type { Tone3000ModelInfo } from '../src/tone3000/client.ts';

const modelVariants: Tone3000ModelInfo[] = [
  { id: '101', toneId: '10', name: 'Clean Bright', size: 'standard', architecture: '1' },
  { id: '102', toneId: '10', name: 'Crunch', size: 'lite', architecture: '2' },
  { id: '103', toneId: '10', name: '', size: 'standard', architecture: 'custom' },
];

test('model variant presentation gives unnamed records a stable exact-id label', () => {
  assert.equal(tone3000ModelVariantLabel(modelVariants[2]), '采样 #103');
});

test('model variant presentation localizes an unspecified API size', () => {
  assert.equal(tone3000ModelSizeLabel('unknown'), '未标注');
  assert.equal(tone3000ModelSizeLabel('standard'), 'standard');
});

test('model variant presentation searches labels and exact ids', () => {
  assert.deepEqual(
    filterTone3000ModelVariants(modelVariants, {
      query: 'bright',
      architecture: 'all',
      size: 'all',
    }).map((modelVariant) => modelVariant.id),
    ['101'],
  );
  assert.deepEqual(
    filterTone3000ModelVariants(modelVariants, {
      query: '103',
      architecture: 'all',
      size: 'all',
    }).map((modelVariant) => modelVariant.id),
    ['103'],
  );
});

test('model variant presentation combines architecture and size filters', () => {
  assert.deepEqual(
    filterTone3000ModelVariants(modelVariants, {
      query: '',
      architecture: '2',
      size: 'lite',
    }).map((modelVariant) => modelVariant.id),
    ['102'],
  );
});

test('model variant presentation puts the current model architecture first', () => {
  assert.deepEqual(
    orderTone3000ModelVariantArchitectures(modelVariants, '101'),
    ['1', '2', 'custom'],
  );
  assert.deepEqual(
    orderTone3000ModelVariantArchitectures(modelVariants, '103'),
    ['custom', '2', '1'],
  );
  assert.deepEqual(
    orderTone3000ModelVariantArchitectures(modelVariants, 'missing'),
    ['2', '1', 'custom'],
  );
});
