/**
 * RigAction 翻译层(issue #8,ADR-0004)——触发源 → RigAction 的唯一入口。
 *
 * 收编三处曾经散落的逻辑(原 App.executeMidiBinding / useMidi switch / 键盘
 * handler):CC 上升沿检测、0..127 → 参数范围的值映射(含 getEffectDef 参数
 * 范围查表)、Note Off 忽略。
 *
 * - `translateBinding`:纯函数,MIDI Learn 绑定命中时
 *   target(地址)+ 原始消息 + 该绑定上一条值 + 链快照 → RigAction|null。
 *   不持有任何状态(沿检测的上一条值由调用方经 nextValue 回传保存)。
 * - `createBindingTranslator`:持有 per-binding 上一条值的工厂(生产用),
 *   纯函数能力的薄包装。
 * - `resolveKeyAction`:键盘按键 → RigAction 的纯函数翻译(映射表从原 App
 *   键盘 handler 平移:1..9 / QWER / 空格)。
 *
 * 默认映射(K25 / motion_midi)的翻译不在这里——`resolveMidiAction`
 * (midiMapping.ts)本就输出 RigAction,签名与行为不变。
 */

import { getEffectDef } from '../audio/effects';
import type { MidiBinding, MidiTarget } from './midiLearn';
import type { ParsedMidiMessage } from './midiMessage';
import {
  AMP_MASTER_RANGE,
  AMP_TONE_RANGE,
  ccToRange,
  type AmpParamKey,
  type RigAction,
} from './midiMapping';

/** CC 上升沿阈值(与原 App.toggleFire 一致:>63 触发,≤63 视为已释放) */
const EDGE_THRESHOLD = 63;

/**
 * toggle 型 target(note 按下 / CC 上升沿触发一次)→ 对应的 RigAction;
 * 连续型 target(值映射)返回 null。toggle 目标全集只在此枚举一次。
 */
function toggleAction(t: MidiTarget): RigAction | null {
  switch (t.kind) {
    case 'pedal-toggle':
      return { type: 'toggle-pedal', index: t.index };
    case 'snapshot':
      return { type: 'recall-snapshot', slot: t.slot };
    case 'bypass':
      return { type: 'toggle-bypass' };
    case 'looper-record':
      return { type: 'looper-record' };
    case 'looper-play':
      return { type: 'looper-toggle-play' };
    case 'looper-clear':
      return { type: 'looper-clear' };
    default:
      return null;
  }
}

export interface BindingTranslation {
  /** 本次消息产生的动作;null = 不产生(Note Off / 沿未触发 / 目标缺失) */
  action: RigAction | null;
  /** 调用方应为该绑定保存的最新值(沿检测的下一次输入) */
  nextValue: number;
}

/**
 * 翻译一条命中 Learn 绑定的消息。
 * chain 为当前链快照(只需 effectId),供 pedal-param 查参数范围;
 * 翻译层不持有链状态,链由调用方从 rigStore 读取后传入,保持纯函数。
 */
export function translateBinding(
  target: MidiTarget,
  msg: ParsedMidiMessage,
  prevValue: number,
  chain: readonly { effectId: string }[],
): BindingTranslation {
  // Note Off 不产生任何动作(避免一次按键触发两次)
  if (msg.type === 'note' && !msg.on) return { action: null, nextValue: prevValue };

  const toggled = toggleAction(target);
  if (toggled) {
    // note 按下即触发;CC 只在上升沿(跨过阈值)触发一次
    const fire =
      msg.type === 'note' || (msg.value > EDGE_THRESHOLD && prevValue <= EDGE_THRESHOLD);
    return {
      action: fire ? toggled : null,
      nextValue: msg.type === 'cc' ? msg.value : prevValue,
    };
  }

  // 连续型:0..127 线性映射到目标范围
  const v = msg.value;
  switch (target.kind) {
    case 'master-volume':
      return { action: { type: 'set-master-volume', value: ccToRange(v, 0, 1) }, nextValue: v };
    case 'amp-param': {
      const range = target.key === 'master' ? AMP_MASTER_RANGE : AMP_TONE_RANGE;
      return {
        action: {
          type: 'set-amp-param',
          key: target.key as AmpParamKey,
          value: ccToRange(v, range.min, range.max),
        },
        nextValue: v,
      };
    }
    case 'pedal-treadle':
      return {
        action: { type: 'set-pedal-treadle', index: target.index, value: ccToRange(v, 0, 100) },
        nextValue: v,
      };
    case 'pedal-param': {
      const item = chain[target.index];
      if (!item) return { action: null, nextValue: v };
      const p = getEffectDef(item.effectId).params.find((x) => x.key === target.key);
      if (!p) return { action: null, nextValue: v };
      return {
        action: {
          type: 'set-pedal-param',
          index: target.index,
          key: target.key,
          value: ccToRange(v, p.min, p.max),
        },
        nextValue: v,
      };
    }
  }
  // 全部 kind 已覆盖(toggle 型在上面提前返回)
  return { action: null, nextValue: v };
}

/**
 * 持有 per-binding 上一条值(CC 沿检测)的翻译器工厂。
 * 签名键与原 App.midiEdgeRef 一致:`source:msgType:number`。
 */
export function createBindingTranslator(): (
  binding: MidiBinding,
  msg: ParsedMidiMessage,
  chain: readonly { effectId: string }[],
) => RigAction | null {
  const prevValues = new Map<string, number>();
  return (binding, msg, chain) => {
    const sig = `${binding.source}:${binding.msgType}:${binding.number}`;
    const { action, nextValue } = translateBinding(
      binding.target,
      msg,
      prevValues.get(sig) ?? 0,
      chain,
    );
    prevValues.set(sig, nextValue);
    return action;
  };
}

// ---------- 键盘 ----------

/** 键盘事件的最小输入面(与 DOM KeyboardEvent 解耦,便于测试) */
export interface KeyStroke {
  code: string;
  key: string;
  repeat: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** 焦点在输入控件(input/textarea/select/contentEditable)时为 true,不触发 */
  editing: boolean;
}

const SNAPSHOT_SLOT_KEYS = ['KeyQ', 'KeyW', 'KeyE', 'KeyR'];

/**
 * 键盘快捷键 → RigAction(映射表平移自原 App 键盘 handler):
 * 空格 = 全局 Bypass;Q/W/E/R = 快照 A..D;数字键 1..9 = 切换链上第 1..9 块单块。
 */
export function resolveKeyAction(stroke: KeyStroke): RigAction | null {
  if (stroke.repeat || stroke.ctrlKey || stroke.metaKey || stroke.altKey || stroke.editing) {
    return null;
  }
  if (stroke.code === 'Space') return { type: 'toggle-bypass' };
  const slotIdx = SNAPSHOT_SLOT_KEYS.indexOf(stroke.code);
  if (slotIdx >= 0) return { type: 'recall-snapshot', slot: slotIdx };
  const n = Number(stroke.key);
  if (Number.isInteger(n) && n >= 1 && n <= 9) return { type: 'toggle-pedal', index: n - 1 };
  return null;
}
