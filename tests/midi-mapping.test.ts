import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMidiMessage } from '../src/midi/midiMessage.ts';
import {
  ccToRange,
  KNOB_BANK_A_CC_START,
  MASTER_KNOB_CC,
  MOTION_EXPRESSION_CC,
  MOTION_SWITCH_CCS,
  PAD_BANK_A_NOTE_START,
  PAD_BANK_B_NOTE_START,
  TRANSPORT_CC,
  resolveMidiAction,
} from '../src/midi/midiMapping.ts';

// ---------- 消息解析 ----------

test('解析 Note On(0x90,velocity > 0)', () => {
  const msg = parseMidiMessage([0x90, 36, 100]);
  assert.deepEqual(msg, { type: 'note', channel: 1, number: 36, value: 100, on: true });
});

test('解析 Note Off(0x80)', () => {
  const msg = parseMidiMessage([0x80, 36, 64]);
  assert.deepEqual(msg, { type: 'note', channel: 1, number: 36, value: 64, on: false });
});

test('Note On velocity = 0 视为 Note Off', () => {
  const msg = parseMidiMessage([0x90, 36, 0]);
  assert.equal(msg?.type, 'note');
  assert.equal(msg?.on, false);
});

test('解析 CC(0xB0)', () => {
  const msg = parseMidiMessage([0xb0, 21, 64]);
  assert.deepEqual(msg, { type: 'cc', channel: 1, number: 21, value: 64, on: false });
});

test('通道从 status 低 4 位解出(1 起)', () => {
  assert.equal(parseMidiMessage([0x99, 36, 100])?.channel, 10);
  assert.equal(parseMidiMessage([0xbf, 21, 1])?.channel, 16);
});

test('不支持的消息与过短数据返回 null', () => {
  assert.equal(parseMidiMessage([0xf8]), null); // 时钟
  assert.equal(parseMidiMessage([0xc0, 5, 0]), null); // PC(0xC0 只有 2 字节,这里按 3 字节传入也不映射)
  assert.equal(parseMidiMessage([0x90, 36]), null); // 过短
  assert.equal(parseMidiMessage(null), null);
});

// ---------- 映射:打击垫 ----------

test('Pad Bank A(note 36..43)→ 单块 1..8', () => {
  for (let i = 0; i < 8; i++) {
    const action = resolveMidiAction(
      parseMidiMessage([0x90, PAD_BANK_A_NOTE_START + i, 100])!,
    );
    assert.deepEqual(action, { type: 'toggle-pedal', index: i });
  }
});

test('Pad Bank B Pad 1..4 → 快照 A..D', () => {
  for (let i = 0; i < 4; i++) {
    const action = resolveMidiAction(
      parseMidiMessage([0x90, PAD_BANK_B_NOTE_START + i, 100])!,
    );
    assert.deepEqual(action, { type: 'recall-snapshot', slot: i });
  }
});

test('Pad Bank B Pad 8 → 全局 Bypass', () => {
  const action = resolveMidiAction(
    parseMidiMessage([0x90, PAD_BANK_B_NOTE_START + 7, 100])!,
  );
  assert.deepEqual(action, { type: 'toggle-bypass' });
});

test('Note Off 不触发动作(避免一次按键触发两次)', () => {
  const off = parseMidiMessage([0x80, PAD_BANK_A_NOTE_START, 0])!;
  assert.equal(resolveMidiAction(off), null);
  const onZeroVelocity = parseMidiMessage([0x90, PAD_BANK_A_NOTE_START, 0])!;
  assert.equal(resolveMidiAction(onZeroVelocity), null);
});

test('未映射的 note / cc 返回 null', () => {
  // 琴键区(60 = C3)默认不映射
  assert.equal(resolveMidiAction(parseMidiMessage([0x90, 60, 100])!), null);
  // Pad Bank B Pad 5..7 暂不映射
  assert.equal(
    resolveMidiAction(parseMidiMessage([0x90, PAD_BANK_B_NOTE_START + 4, 100])!),
    null,
  );
  // 未映射 CC
  assert.equal(resolveMidiAction(parseMidiMessage([0xb0, 1, 64])!), null);
});

// ---------- 映射:走带键 ----------

test('走带:Record/Play 为 Toggle 模式,每次按下交替发 127/0,都要触发', () => {
  for (const v of [127, 0]) {
    assert.deepEqual(resolveMidiAction(parseMidiMessage([0xb0, TRANSPORT_CC.record, v])!), {
      type: 'looper-record',
    });
    assert.deepEqual(resolveMidiAction(parseMidiMessage([0xb0, TRANSPORT_CC.play, v])!), {
      type: 'looper-toggle-play',
    });
  }
});

test('走带:Stop 为 Momentary,按下(值>0)触发,松开(值 0)不触发', () => {
  assert.deepEqual(resolveMidiAction(parseMidiMessage([0xb0, TRANSPORT_CC.stop, 127])!), {
    type: 'looper-clear',
  });
  assert.equal(resolveMidiAction(parseMidiMessage([0xb0, TRANSPORT_CC.stop, 0])!), null);
});

// ---------- 映射:旋钮 CC 0..127 → 参数范围 ----------

test('ccToRange 线性映射并夹取 0..127', () => {
  assert.equal(ccToRange(0, 0, 2), 0);
  assert.equal(ccToRange(127, 0, 2), 2);
  assert.equal(ccToRange(64, -30, 6), -30 + (64 / 127) * 36);
  assert.equal(ccToRange(200, 0, 1), 1); // 超出按 127 计
  assert.equal(ccToRange(-5, 0, 1), 0);
});

test('主音量旋钮 → Master Volume(0..1)', () => {
  assert.deepEqual(resolveMidiAction(parseMidiMessage([0xb0, MASTER_KNOB_CC, 127])!), {
    type: 'set-master-volume',
    value: 1,
  });
  assert.deepEqual(resolveMidiAction(parseMidiMessage([0xb0, MASTER_KNOB_CC, 0])!), {
    type: 'set-master-volume',
    value: 0,
  });
});

test('K2..K6 → 箱头 gain/bass/mid/treble/presence(0..100)', () => {
  const keys = ['gain', 'bass', 'mid', 'treble', 'presence'] as const;
  keys.forEach((key, i) => {
    const cc = KNOB_BANK_A_CC_START + 1 + i; // K2..K6
    assert.deepEqual(resolveMidiAction(parseMidiMessage([0xb0, cc, 127])!), {
      type: 'set-amp-param',
      key,
      value: 100,
    });
    assert.deepEqual(resolveMidiAction(parseMidiMessage([0xb0, cc, 0])!), {
      type: 'set-amp-param',
      key,
      value: 0,
    });
  });
});

test('K8 → 箱头 master(-30..6 dB)', () => {
  const k8 = KNOB_BANK_A_CC_START + 7;
  assert.deepEqual(resolveMidiAction(parseMidiMessage([0xb0, k8, 0])!), {
    type: 'set-amp-param',
    key: 'master',
    value: -30,
  });
  assert.deepEqual(resolveMidiAction(parseMidiMessage([0xb0, k8, 127])!), {
    type: 'set-amp-param',
    key: 'master',
    value: 6,
  });
});

test('K1(与 Mod 条同号)预留,不映射', () => {
  assert.equal(
    resolveMidiAction(parseMidiMessage([0xb0, KNOB_BANK_A_CC_START, 64])!),
    null,
  );
  // K7(CC07)与 MASTER_KNOB_CC 同号:实机核对前 CC07 统一按主音量旋钮处理
});

// ---------- 映射:motion_midi(IAC 总线,按输入端口名路由) ----------

test('IAC 来源:CC11 表情踏板 → 归一化 0..1', () => {
  assert.deepEqual(
    resolveMidiAction(parseMidiMessage([0xb0, MOTION_EXPRESSION_CC, 0])!, 'IAC Driver Bus 1'),
    { type: 'set-expression', value: 0 },
  );
  assert.deepEqual(
    resolveMidiAction(parseMidiMessage([0xb0, MOTION_EXPRESSION_CC, 127])!, 'IAC Driver Bus 1'),
    { type: 'set-expression', value: 1 },
  );
});

test('IAC 来源:踩钉 1/2/4(Toggle)按值绝对设置单块开关', () => {
  // CC20/21/23 → 单块 1/2/4;127=开,0=关(状态由 motion_midi 维护)
  assert.deepEqual(resolveMidiAction(parseMidiMessage([0xb0, 20, 127])!, 'IAC Driver'), {
    type: 'set-pedal-enabled',
    index: 0,
    enabled: true,
  });
  assert.deepEqual(resolveMidiAction(parseMidiMessage([0xb0, 20, 0])!, 'IAC Driver'), {
    type: 'set-pedal-enabled',
    index: 0,
    enabled: false,
  });
  assert.deepEqual(resolveMidiAction(parseMidiMessage([0xb0, 23, 127])!, 'IAC Driver'), {
    type: 'set-pedal-enabled',
    index: 3,
    enabled: true,
  });
});

test('IAC 来源:踩钉 3(Momentary)127 开、回 0 关', () => {
  assert.deepEqual(resolveMidiAction(parseMidiMessage([0xb0, 22, 127])!, 'IAC Driver'), {
    type: 'set-pedal-enabled',
    index: 2,
    enabled: true,
  });
  assert.deepEqual(resolveMidiAction(parseMidiMessage([0xb0, 22, 0])!, 'IAC Driver'), {
    type: 'set-pedal-enabled',
    index: 2,
    enabled: false,
  });
});

test('IAC 来源:未映射消息返回 null(踩钉的 note、其他 CC)', () => {
  assert.equal(resolveMidiAction(parseMidiMessage([0x90, 36, 100])!, 'IAC Driver'), null);
  assert.equal(resolveMidiAction(parseMidiMessage([0xb0, 30, 127])!, 'IAC Driver'), null);
});

test('非 IAC 来源:CC11/20-23 不触发 motion 映射(按 K25 映射处理,均未映射)', () => {
  for (const cc of [MOTION_EXPRESSION_CC, ...MOTION_SWITCH_CCS]) {
    assert.equal(resolveMidiAction(parseMidiMessage([0xb0, cc, 127])!, 'TempoKEY K25'), null);
    // 不传来源名(旧调用方式)同样走 K25 映射
    assert.equal(resolveMidiAction(parseMidiMessage([0xb0, cc, 127])!), null);
  }
});
