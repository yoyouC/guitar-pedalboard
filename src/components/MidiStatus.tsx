/**
 * MidiStatus:TopBar 里的 MIDI 状态指示。
 * 显示 未支持 / 未连接 / 已连接(设备名);点击展开最近一条原始 MIDI 消息,
 * 兼任调试监视器——首次接入 K25 时按控件核对实际 Note/CC 编号,
 * 不一致就改 src/midi/midiMapping.ts 顶部的编号常量。
 */

import { useState } from 'react';
import type { MidiState } from '../midi/useMidi';

export function MidiStatus({ midi }: { midi: MidiState }) {
  const [open, setOpen] = useState(false);

  // 浏览器不支持 Web MIDI(Safari/Firefox):不显示入口,优雅降级
  if (!midi.supported) return null;

  const connected = midi.enabled && midi.deviceName !== null;
  const label = connected
    ? `🎹 ${midi.deviceName}`
    : midi.enabled
      ? '🎹 等待设备'
      : '🎹 未连接';

  const { lastMessage } = midi;

  return (
    <div className="midi-status">
      <button
        className={`midi-status-btn ${connected ? 'connected' : ''}`}
        title={
          connected
            ? `MIDI 已连接:${midi.deviceName}(点击展开消息监视器)`
            : '未检测到 MIDI 输入设备(需浏览器授权 MIDI 访问)'
        }
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {open && (
        <div className="midi-monitor">
          <div className="midi-monitor-title">MIDI 监视器(核对映射编号用)</div>
          {lastMessage ? (
            <>
              <div className="midi-monitor-row">
                原始字节:<code>{lastMessage.hex}</code>
              </div>
              <div className="midi-monitor-row">
                {lastMessage.parsed
                  ? lastMessage.parsed.type === 'note'
                    ? `Note ${lastMessage.parsed.on ? 'On' : 'Off'} · 音符号 ${lastMessage.parsed.number} · 力度 ${lastMessage.parsed.value} · 通道 ${lastMessage.parsed.channel}`
                    : `CC · 控制器号 ${lastMessage.parsed.number} · 值 ${lastMessage.parsed.value} · 通道 ${lastMessage.parsed.channel}`
                  : '未识别的消息类型'}
              </div>
            </>
          ) : (
            <div className="midi-monitor-row">尚未收到消息,按一下琴键/垫/旋钮试试</div>
          )}
          <div className="midi-monitor-hint">
            编号与预期不符?改 src/midi/midiMapping.ts 顶部的编号常量
          </div>
        </div>
      )}
    </div>
  );
}
