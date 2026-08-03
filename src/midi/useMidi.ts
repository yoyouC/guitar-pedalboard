/**
 * useMidi:Web MIDI 接入层。
 * 请求 MIDI 访问权限(不带 sysex),监听热插拔,给所有输入设备挂消息监听,
 * 解析 → 映射 → 调 App 传入的动作回调。浏览器不支持时优雅降级(supported=false)。
 */

import { useEffect, useRef, useState } from 'react';
import { formatMidiBytes, parseMidiMessage, type ParsedMidiMessage } from './midiMessage';
import { resolveMidiAction, type AmpParamKey } from './midiMapping';

/** App 传入的一组动作回调(每次渲染可换新对象,hook 内部用 ref 持有) */
export interface MidiActions {
  /** 切换效果链第 index 块单块(0 起) */
  togglePedal(index: number): void;
  /** 召回快照 0..3 */
  recallSnapshot(slot: number): void;
  toggleBypass(): void;
  /** Looper 录音开始/结束(由调用方按当前相位分派) */
  looperRecord(): void;
  looperTogglePlay(): void;
  looperClear(): void;
  setMasterVolume(value: number): void;
  setAmpParam(key: AmpParamKey, value: number): void;
  /** 绝对设置效果链第 index 块单块开关(motion_midi 踩钉) */
  setPedalEnabled(index: number, enabled: boolean): void;
  /** 表情踏板位置,归一化 0..1;index 0 = 第 1 块(CC11),1 = 第 2 块(CC12) */
  setExpression(index: number, value: number): void;
}

/** 最近收到的一条原始消息,供 MidiStatus 调试面板显示 */
export interface MidiLastMessage {
  /** 十六进制字节串,如 "B0 15 40" */
  hex: string;
  /** 解析结果(不支持的消息类型为 null) */
  parsed: ParsedMidiMessage | null;
  at: number;
}

export interface MidiState {
  /** 浏览器是否支持 Web MIDI */
  supported: boolean;
  /** 是否已拿到 MIDI 访问权限(用户授权成功) */
  enabled: boolean;
  /** 第一个输入设备名;无设备为 null */
  deviceName: string | null;
  lastMessage: MidiLastMessage | null;
}

export function useMidi(actions: MidiActions): MidiState {
  const [supported] = useState(
    () => typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator,
  );
  const [enabled, setEnabled] = useState(false);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [lastMessage, setLastMessage] = useState<MidiLastMessage | null>(null);

  // actions 每次渲染都会是新对象,用 ref 持有最新版本,MIDI 监听只需挂一次
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    if (!supported) return;
    let access: MIDIAccess | null = null;
    // 严格模式下 effect 会挂载→清理→再挂载,用 cancelled 丢弃第一次的异步结果
    let cancelled = false;

    const onMessage = (event: MIDIMessageEvent, sourceName?: string | null) => {
      if (!event.data) return;
      const parsed = parseMidiMessage(event.data);
      setLastMessage({ hex: formatMidiBytes(event.data), parsed, at: Date.now() });
      if (!parsed) return;
      const action = resolveMidiAction(parsed, sourceName);
      if (!action) return;
      const a = actionsRef.current;
      switch (action.type) {
        case 'toggle-pedal':
          a.togglePedal(action.index);
          break;
        case 'recall-snapshot':
          a.recallSnapshot(action.slot);
          break;
        case 'toggle-bypass':
          a.toggleBypass();
          break;
        case 'looper-record':
          a.looperRecord();
          break;
        case 'looper-toggle-play':
          a.looperTogglePlay();
          break;
        case 'looper-clear':
          a.looperClear();
          break;
        case 'set-master-volume':
          a.setMasterVolume(action.value);
          break;
        case 'set-amp-param':
          a.setAmpParam(action.key, action.value);
          break;
        case 'set-pedal-enabled':
          a.setPedalEnabled(action.index, action.enabled);
          break;
        case 'set-expression':
          a.setExpression(action.index, action.value);
          break;
      }
    };

    /** 给所有输入设备挂监听,并刷新显示的设备名(热插拔时复用) */
    const attachInputs = () => {
      if (!access) return;
      let name: string | null = null;
      for (const input of access.inputs.values()) {
        if (!name) name = input.name ?? null;
        // 闭包带上端口名:IAC 总线的消息走 motion_midi 映射(见 midiMapping)
        input.onmidimessage = (e) => onMessage(e, input.name);
      }
      setDeviceName(name);
    };

    navigator
      .requestMIDIAccess({ sysex: false })
      .then((a) => {
        if (cancelled) return;
        access = a;
        a.onstatechange = attachInputs;
        attachInputs();
        setEnabled(true);
      })
      .catch((e) => {
        // 用户拒绝授权或平台不支持:保持 enabled=false,UI 显示未连接
        console.warn('MIDI 访问失败:', e);
      });

    return () => {
      cancelled = true;
      if (access) {
        access.onstatechange = null;
        for (const input of access.inputs.values()) input.onmidimessage = null;
      }
    };
  }, [supported]);

  return { supported, enabled, deviceName, lastMessage };
}
