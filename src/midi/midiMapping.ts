/**
 * MIDI 默认映射表(Synido TempoKEY K25)+ 纯函数 resolveMidiAction。
 * 映射方案见 docs/midi-mapping-plan.md 第 3 节。
 *
 * 编号来源:K25 官方说明书出厂默认表(已核对)
 * - 打击垫:Bank A = Note 36..43,Bank B = Note 44..51(说明书 p.07,实机已验证)
 * - 小旋钮:Bank A K1..K8 = CC#01..08,Bank B = CC#09..16(说明书 p.07)
 * - 走带键:Loop=CC21、快退=22、快进=23、Stop=24(Momentary)、
 *   Play/Pause=25(Toggle)、Record=26(Toggle)(说明书 p.10)
 * - 主音量旋钮:说明书只说 "adjusts the master volume",未给 CC 号,
 *   按标准音量 CC#07 填的初值,**待实机核对**(点 TopBar 的 MIDI 指示,
 *   展开面板转动主音量旋钮即可看到实际编号,不一致改 MASTER_KNOB_CC)。
 *
 * K25 的所有编号都可以在 Synido 控制软件或设备菜单里改配,改配后只需
 * 改本文件顶部的常量。
 */

import { LEVEL_DB_MAX, LEVEL_DB_MIN } from '../audio/level';
import type { ParsedMidiMessage } from './midiMessage';

// ---------- 编号常量(实机核对/改配时改这里) ----------

/** Pad Bank A:8 个垫,Note 36(C1)起连续 —— 切换效果链第 1..8 块单块 */
export const PAD_BANK_A_NOTE_START = 36;

/**
 * Pad Bank B:8 个垫,Note 44 起连续。
 * Pad 1..4(44..47)→ 快照 A..D;Pad 8(51)→ 全局 Bypass;Pad 5..7 暂不映射。
 */
export const PAD_BANK_B_NOTE_START = 44;

/** 走带键 CC 号(出厂默认):Play/Pause、Record 为 Toggle 模式,Stop 为 Momentary */
export const TRANSPORT_CC = {
  play: 25,
  stop: 24,
  record: 26,
} as const;

/** Knob Bank A:K1..K8 = CC#01..08(出厂默认) */
export const KNOB_BANK_A_CC_START = 1;

/**
 * 主音量旋钮 → Master 输出。说明书未给 CC 号,按标准音量 CC#07 初值,待实机核对。
 */
export const MASTER_KNOB_CC = 7;

// ---------- motion_midi(面部表情 → MIDI,经 macOS IAC 总线输入) ----------

/**
 * motion_midi 默认预设(通道 1,定义见该项目 src/mapping/presets.ts):
 * - 表情踏板(张嘴)→ CC11,连续 0..127
 * - 踩钉 1/2/4(眨眼/挑眉/微笑)→ CC20/21/23,Toggle:交替发 127(开)/0(关)
 * - 踩钉 3(点头)→ CC22,Momentary:发 127,约 120ms 后自动回 0
 *
 * 与 K25 的映射按输入端口名隔离:只有名字匹配 IAC 的输入才走这套映射,
 * 避免与 K25 的 CC 号(Knob Bank B = CC09..16 等)冲突。
 */

/** IAC 输入端口名匹配(motion_midi 在 UI 里选择 IAC Driver 总线作为输出) */
export const MOTION_INPUT_NAME_PATTERN = /iac/i;

/**
 * 表情踏板 CC → 链上第 N 块摇杆类踏板(whammy/wahpedal/crybabywdf 的 position)。
 * CC11 = 第 1 块,CC12 = 第 2 块(motion_midi 双踏板);兜底规则见 App 的 setExpression。
 */
export const MOTION_EXPRESSION_CCS = [11, 12] as const;

/** 踩钉 1..4 的 CC 号 → 按板上顺序绝对设置第 1..4 块单块的 enabled */
export const MOTION_SWITCH_CCS = [20, 21, 22, 23] as const;

// ---------- 参数范围(与 UI 滑杆/箱头定义一致) ----------

/** Master Volume 范围,与 TopBar 的 MASTER 滑杆一致 */
export const MASTER_VOLUME_RANGE = { min: 0, max: 1 } as const;
/**
 * 箱头参数范围(src/audio/amps.ts):gain/bass/mid/treble/presence 均为 0..100,
 * master 为 LEVEL_DB_MIN..MAX dB。
 */
export const AMP_TONE_RANGE = { min: 0, max: 100 } as const;
export const AMP_MASTER_RANGE = { min: LEVEL_DB_MIN, max: LEVEL_DB_MAX } as const;

/** 可通过 MIDI 调节的箱头参数 */
export type AmpParamKey = 'gain' | 'bass' | 'mid' | 'treble' | 'presence' | 'master';

/**
 * 小旋钮 → 箱头参数(K2..K6 + K8,共 6 个,对应音箱的 6 个参数)。
 * K1(CC#01)预留:出厂与 Modulation 触控条同号(说明书 p.11),避免误触;
 * K7(CC#07)预留:与主音量旋钮疑似同号(见 MASTER_KNOB_CC),避免一扭两调。
 */
export const AMP_KNOB_MAP: ReadonlyMap<number, AmpParamKey> = new Map([
  [KNOB_BANK_A_CC_START + 1, 'gain'], // K2
  [KNOB_BANK_A_CC_START + 2, 'bass'], // K3
  [KNOB_BANK_A_CC_START + 3, 'mid'], // K4
  [KNOB_BANK_A_CC_START + 4, 'treble'], // K5
  [KNOB_BANK_A_CC_START + 5, 'presence'], // K6
  [KNOB_BANK_A_CC_START + 7, 'master'], // K8
]);

// ---------- 动作 ----------

export type MidiAction =
  /** 切换效果链第 index 块单块(0 起,对齐数字键 1..8) */
  | { type: 'toggle-pedal'; index: number }
  /** 召回快照 slot(0..3 = A..D,对齐 Q/W/E/R) */
  | { type: 'recall-snapshot'; slot: number }
  /** 全局 Bypass(对齐空格) */
  | { type: 'toggle-bypass' }
  /** Looper:录音开始/结束(由调用方按当前相位分派 start/finish) */
  | { type: 'looper-record' }
  /** Looper:播放/停止 */
  | { type: 'looper-toggle-play' }
  /** Looper:清除循环 */
  | { type: 'looper-clear' }
  /** 设置 Master Volume(value 已在 MASTER_VOLUME_RANGE 内) */
  | { type: 'set-master-volume'; value: number }
  /** 设置箱头参数(0..100 或 master dB,均为线性映射后的实际值) */
  | { type: 'set-amp-param'; key: AmpParamKey; value: number }
  /**
   * 绝对设置效果链第 index 块单块的 enabled(motion_midi 踩钉;
   * Toggle 状态由发送方维护,这里按值设置而非翻转,保持两端同步)
   */
  | { type: 'set-pedal-enabled'; index: number; enabled: boolean }
  /** 表情踏板位置,归一化 0..1;index 0 = 第 1 块踏板(CC11),1 = 第 2 块(CC12) */
  | { type: 'set-expression'; index: number; value: number };

/** CC 值 0..127 线性映射到 [min, max] */
export function ccToRange(ccValue: number, min: number, max: number): number {
  const t = Math.max(0, Math.min(127, ccValue)) / 127;
  return min + t * (max - min);
}

/**
 * 把解析后的 MIDI 消息映射成动作;未映射返回 null。
 * 不区分通道(K25 / motion_midi 默认都是通道 1,改通道不影响映射)。
 * sourceName 为输入端口名:匹配 IAC 时走 motion_midi 映射(见文件顶部),
 * 否则走 K25 映射,两套 CC 号互不干扰。
 * Note 只在按下(Note On)时触发,忽略 Note Off,避免一次按键触发两次。
 * Toggle 模式的走带键(Play/Record)每次按下交替发 127/0,都要触发;
 * Momentary 的 Stop 只在按下值(>0)时触发,忽略松开时的 0。
 */
export function resolveMidiAction(
  msg: ParsedMidiMessage,
  sourceName?: string | null,
): MidiAction | null {
  // motion_midi(IAC 总线):表情踏板 + 4 个踩钉
  if (sourceName && MOTION_INPUT_NAME_PATTERN.test(sourceName)) {
    if (msg.type !== 'cc') return null;
    const exprIndex = MOTION_EXPRESSION_CCS.indexOf(msg.number as 11 | 12);
    if (exprIndex >= 0) {
      return {
        type: 'set-expression',
        index: exprIndex,
        value: Math.max(0, Math.min(127, msg.value)) / 127,
      };
    }
    const switchIndex = MOTION_SWITCH_CCS.indexOf(msg.number as 20 | 21 | 22 | 23);
    if (switchIndex >= 0) {
      // Toggle 钉 127=开/0=关;Momentary 钉 127 触发、回 0 复位,统一按绝对值设置
      return { type: 'set-pedal-enabled', index: switchIndex, enabled: msg.value > 0 };
    }
    return null;
  }

  if (msg.type === 'note') {
    if (!msg.on) return null;
    // Pad Bank A → 单块 1..8
    const pedalIndex = msg.number - PAD_BANK_A_NOTE_START;
    if (pedalIndex >= 0 && pedalIndex < 8) return { type: 'toggle-pedal', index: pedalIndex };
    // Pad Bank B:Pad 1..4 → 快照 A..D
    const bankBIndex = msg.number - PAD_BANK_B_NOTE_START;
    if (bankBIndex >= 0 && bankBIndex < 4) return { type: 'recall-snapshot', slot: bankBIndex };
    // Pad Bank B:Pad 8 → 全局 Bypass
    if (bankBIndex === 7) return { type: 'toggle-bypass' };
    return null;
  }

  // CC:走带键
  if (msg.number === TRANSPORT_CC.record) return { type: 'looper-record' };
  if (msg.number === TRANSPORT_CC.play) return { type: 'looper-toggle-play' };
  if (msg.number === TRANSPORT_CC.stop) return msg.value > 0 ? { type: 'looper-clear' } : null;

  // CC:主音量旋钮 → Master 输出
  if (msg.number === MASTER_KNOB_CC) {
    return {
      type: 'set-master-volume',
      value: ccToRange(msg.value, MASTER_VOLUME_RANGE.min, MASTER_VOLUME_RANGE.max),
    };
  }

  // CC:小旋钮 → 箱头参数(预留的 K1/K7 不在 AMP_KNOB_MAP 中)
  const ampKey = AMP_KNOB_MAP.get(msg.number);
  if (ampKey) {
    const range = ampKey === 'master' ? AMP_MASTER_RANGE : AMP_TONE_RANGE;
    return { type: 'set-amp-param', key: ampKey, value: ccToRange(msg.value, range.min, range.max) };
  }

  return null;
}
