/**
 * MIDI 消息解析:把 MIDIMessageEvent.data 的原始字节解析成结构化消息。
 * 纯函数,不依赖 DOM,便于单测。
 */

export interface ParsedMidiMessage {
  type: 'note' | 'cc';
  /** MIDI 通道 1..16 */
  channel: number;
  /** Note:音符号;CC:控制器号 */
  number: number;
  /** Note:力度(0..127);CC:控制器值(0..127) */
  value: number;
  /** 仅 Note 有意义:true = Note On;false = Note Off(含 Note On velocity=0 的惯例) */
  on: boolean;
}

/**
 * 解析一条 MIDI 消息。
 * 只关心 Note On/Off 与 CC,其余(触后、PC、Pitch Bend 等)返回 null。
 */
export function parseMidiMessage(data: Uint8Array | number[] | null): ParsedMidiMessage | null {
  if (!data || data.length < 3) return null;
  const [status, d1, d2] = data;
  const kind = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  switch (kind) {
    case 0x90:
      // Note On;velocity = 0 按惯例视为 Note Off
      return { type: 'note', channel, number: d1, value: d2, on: d2 > 0 };
    case 0x80:
      return { type: 'note', channel, number: d1, value: d2, on: false };
    case 0xb0:
      return { type: 'cc', channel, number: d1, value: d2, on: false };
    default:
      return null;
  }
}

/** 调试显示用:原始字节转十六进制字符串,如 "90 24 64" */
export function formatMidiBytes(data: Uint8Array | number[]): string {
  return Array.from(data, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
