/**
 * MIDI Learn:用户自定义映射层。
 * 默认映射(midiMapping.ts)不变;用户绑定优先于默认映射解析,
 * 绑定持久化到 localStorage。学习流程:Learn 模式点控件(armed)→
 * 动一下 MIDI 控制器 → 生成绑定(同 target 或同消息的旧绑定被替换)。
 */

import type { ParsedMidiMessage } from './midiMessage';
import { MOTION_INPUT_NAME_PATTERN } from './midiMapping';

/** 绑定目标(纯地址类型,"绑的是哪个控件";链上位置语义,与默认映射一致:
 *  单块按链序索引,0 起)。与 RigAction("要执行什么"的意图,携带语义值)
 *  是两个概念:地址 + 原始值 → 翻译层(rigAction.ts)→ RigAction(ADR-0004)。 */
export type MidiTarget =
  | { kind: 'pedal-toggle'; index: number }
  | { kind: 'pedal-param'; index: number; key: string }
  | { kind: 'pedal-treadle'; index: number }
  | { kind: 'snapshot'; slot: number }
  | { kind: 'bypass' }
  | { kind: 'master-volume' }
  | { kind: 'amp-param'; key: string }
  | { kind: 'looper-record' }
  | { kind: 'looper-play' }
  | { kind: 'looper-clear' };

/** 来源分类(与默认映射的 IAC 区分一致,避免 K25 与 motion_midi 同 CC 号冲突) */
export type MidiSource = 'iac' | 'other';

export interface MidiBinding {
  msgType: 'cc' | 'note';
  number: number;
  source: MidiSource;
  target: MidiTarget;
}

export function classifySource(sourceName?: string | null): MidiSource {
  return sourceName && MOTION_INPUT_NAME_PATTERN.test(sourceName) ? 'iac' : 'other';
}

/** 运行时匹配:类型 + 编号 + 来源分类;Note Off 不匹配任何绑定 */
export function bindingMatches(
  b: MidiBinding,
  msg: ParsedMidiMessage,
  source: MidiSource,
): boolean {
  if (b.source !== source) return false;
  if (b.msgType !== msg.type) return false;
  if (b.number !== msg.number) return false;
  if (msg.type === 'note' && !msg.on) return false;
  return true;
}

/** 消息签名(同消息只允许绑一个目标) */
function msgSig(b: MidiBinding): string {
  return `${b.source}:${b.msgType}:${b.number}`;
}

// ---------- data-midi-target 属性序列化 ----------

/** 序列化为 data-midi-target 属性值,如 'pedal-param:2:drive' */
export function serializeTarget(t: MidiTarget): string {
  switch (t.kind) {
    case 'pedal-toggle':
      return `pedal-toggle:${t.index}`;
    case 'pedal-param':
      return `pedal-param:${t.index}:${t.key}`;
    case 'pedal-treadle':
      return `pedal-treadle:${t.index}`;
    case 'snapshot':
      return `snapshot:${t.slot}`;
    case 'amp-param':
      return `amp-param:${t.key}`;
    default:
      return t.kind; // bypass / master-volume / looper-*
  }
}

/** 解析 data-midi-target 属性值;非法返回 null */
export function parseTarget(s: string): MidiTarget | null {
  const [kind, a, b] = s.split(':');
  const num = a !== undefined && a !== '' && Number.isFinite(Number(a)) ? Number(a) : null;
  switch (kind) {
    case 'pedal-toggle':
      return num !== null ? { kind, index: num } : null;
    case 'pedal-param':
      return num !== null && b ? { kind, index: num, key: b } : null;
    case 'pedal-treadle':
      return num !== null ? { kind, index: num } : null;
    case 'snapshot':
      return num !== null ? { kind, slot: num } : null;
    case 'amp-param':
      return a ? { kind, key: a } : null;
    case 'bypass':
    case 'master-volume':
    case 'looper-record':
    case 'looper-play':
    case 'looper-clear':
      return { kind };
    default:
      return null;
  }
}

/** 目标签名(同目标只允许一个绑定) */
function targetSig(t: MidiTarget): string {
  switch (t.kind) {
    case 'pedal-param':
      return `${t.kind}:${t.index}:${t.key}`;
    case 'amp-param':
      return `${t.kind}:${t.key}`;
    case 'pedal-toggle':
    case 'pedal-treadle':
      return `${t.kind}:${t.index}`;
    case 'snapshot':
      return `${t.kind}:${t.slot}`;
    default:
      return t.kind;
  }
}

/** 追加/替换绑定:同 target 或同消息的先行删除 */
export function upsertBinding(list: MidiBinding[], b: MidiBinding): MidiBinding[] {
  const sig = msgSig(b);
  const tsig = targetSig(b.target);
  return [...list.filter((x) => msgSig(x) !== sig && targetSig(x.target) !== tsig), b];
}

const SLOT_NAMES = ['A', 'B', 'C', 'D'];

export function targetLabel(t: MidiTarget): string {
  switch (t.kind) {
    case 'pedal-toggle':
      return `单块 ${t.index + 1} 开关`;
    case 'pedal-param':
      return `单块 ${t.index + 1} · ${t.key}`;
    case 'pedal-treadle':
      return `踏板 ${t.index + 1} 行程`;
    case 'snapshot':
      return `快照 ${SLOT_NAMES[t.slot] ?? t.slot}`;
    case 'bypass':
      return '全局 Bypass';
    case 'master-volume':
      return 'Master Volume';
    case 'amp-param':
      return `箱头 ${t.key}`;
    case 'looper-record':
      return 'Looper 录音';
    case 'looper-play':
      return 'Looper 播放/停止';
    case 'looper-clear':
      return 'Looper 清除';
  }
}

export function bindingLabel(b: MidiBinding): string {
  const src = b.source === 'iac' ? 'IAC · ' : '';
  const msg = b.msgType === 'cc' ? `CC${b.number}` : `Note${b.number}`;
  return `${src}${msg} → ${targetLabel(b.target)}`;
}

// ---------- localStorage 持久化 ----------

const LS_KEY = 'guitar-pedalboard.midi-bindings.v1';

export function loadMidiBindings(): MidiBinding[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveMidiBindings(bindings: MidiBinding[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(bindings));
  } catch {
    /* 存储满/隐私模式:忽略 */
  }
}
