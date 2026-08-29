import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bindingLabel,
  bindingMatches,
  parseTarget,
  serializeTarget,
  upsertBinding,
  type MidiBinding,
  type MidiTarget,
} from '../src/midi/midiLearn.ts';

const ALL_TARGETS: MidiTarget[] = [
  { kind: 'pedal-toggle', index: 3 },
  { kind: 'pedal-param', index: 0, key: 'drive' },
  { kind: 'pedal-treadle', index: 1 },
  { kind: 'snapshot', slot: 2 },
  { kind: 'bypass' },
  { kind: 'master-volume' },
  { kind: 'amp-param', key: 'gain' },
  { kind: 'preamp-eq-toggle' },
  { kind: 'preamp-eq-band', key: 'hz1000' },
  { kind: 'preamp-eq-level' },
  { kind: 'looper-record' },
  { kind: 'looper-play' },
  { kind: 'looper-clear' },
];

test('serializeTarget/parseTarget 往返', () => {
  for (const t of ALL_TARGETS) {
    assert.deepEqual(parseTarget(serializeTarget(t)), t, serializeTarget(t));
  }
});

test('parseTarget 非法输入返回 null', () => {
  assert.equal(parseTarget(''), null);
  assert.equal(parseTarget('garbage'), null);
  assert.equal(parseTarget('pedal-toggle:'), null);
  assert.equal(parseTarget('pedal-param:0'), null);
  assert.equal(parseTarget('preamp-eq-band:not-a-band'), null);
});

test('upsertBinding:同 target 替换', () => {
  let list: MidiBinding[] = [];
  list = upsertBinding(list, { msgType: 'cc', number: 11, source: 'iac', target: { kind: 'pedal-treadle', index: 0 } });
  list = upsertBinding(list, { msgType: 'cc', number: 20, source: 'iac', target: { kind: 'pedal-toggle', index: 1 } });
  assert.equal(list.length, 2);
  list = upsertBinding(list, { msgType: 'cc', number: 21, source: 'iac', target: { kind: 'pedal-treadle', index: 0 } });
  assert.equal(list.length, 2, '同 target 不新增');
  assert.equal(list[1].number, 21, 'target 绑定到新消息');
});

test('upsertBinding:同消息替换', () => {
  let list: MidiBinding[] = [];
  list = upsertBinding(list, { msgType: 'cc', number: 21, source: 'iac', target: { kind: 'pedal-treadle', index: 0 } });
  list = upsertBinding(list, { msgType: 'cc', number: 21, source: 'iac', target: { kind: 'bypass' } });
  assert.equal(list.length, 1, '同消息只保留最新绑定');
  assert.equal(list[0].target.kind, 'bypass');
});

test('bindingMatches:类型/编号/来源/NoteOff', () => {
  const b: MidiBinding = { msgType: 'cc', number: 11, source: 'iac', target: { kind: 'pedal-treadle', index: 0 } };
  assert.equal(bindingMatches(b, { type: 'cc', number: 11, value: 64, channel: 1 }, 'iac'), true);
  assert.equal(bindingMatches(b, { type: 'cc', number: 11, value: 64, channel: 1 }, 'other'), false, '来源隔离');
  assert.equal(bindingMatches(b, { type: 'cc', number: 12, value: 64, channel: 1 }, 'iac'), false, '编号不符');
  const nb: MidiBinding = { msgType: 'note', number: 36, source: 'other', target: { kind: 'pedal-toggle', index: 0 } };
  assert.equal(bindingMatches(nb, { type: 'note', number: 36, value: 100, on: true, channel: 1 }, 'other'), true);
  assert.equal(bindingMatches(nb, { type: 'note', number: 36, value: 0, on: false, channel: 1 }, 'other'), false, 'Note Off 不匹配');
});

test('标签可读', () => {
  assert.equal(
    bindingLabel({ msgType: 'cc', number: 11, source: 'iac', target: { kind: 'pedal-treadle', index: 0 } }),
    'IAC · CC11 → 踏板 1 行程',
  );
  assert.equal(
    bindingLabel({ msgType: 'note', number: 36, source: 'other', target: { kind: 'snapshot', slot: 1 } }),
    'Note36 → 快照 B',
  );
  assert.equal(
    bindingLabel({ msgType: 'cc', number: 12, source: 'other', target: { kind: 'preamp-eq-band', key: 'hz1000' } }),
    'CC12 → 箱头前 EQ · 1k',
  );
});
