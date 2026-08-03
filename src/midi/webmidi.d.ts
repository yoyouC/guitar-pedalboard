/**
 * Web MIDI API 的最小类型声明。
 * TS 的 lib.dom 未内置 Web MIDI 类型,这里只声明本项目用到的部分;
 * 若未来 TS 内置了这些类型,删除本文件即可(重复声明会在 tsc 时报错)。
 */

interface MIDIMessageEvent extends Event {
  /** 原始 MIDI 字节:[status, data1, data2] */
  readonly data: Uint8Array;
}

interface MIDIInput extends EventTarget {
  readonly id: string;
  readonly name?: string;
  readonly state: 'connected' | 'disconnected';
  onmidimessage: ((event: MIDIMessageEvent) => void) | null;
}

interface MIDIConnectionEvent extends Event {
  readonly port: MIDIInput;
}

interface MIDIAccess extends EventTarget {
  readonly inputs: ReadonlyMap<string, MIDIInput>;
  onstatechange: ((event: MIDIConnectionEvent) => void) | null;
}

interface Navigator {
  requestMIDIAccess(options?: { sysex?: boolean }): Promise<MIDIAccess>;
}
