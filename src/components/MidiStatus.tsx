/**
 * MidiStatus:TopBar 里的 MIDI 状态指示。
 * 显示 未支持 / 未连接 / 已连接(设备名);点击展开最近一条原始 MIDI 消息,
 * 兼任调试监视器——首次接入 K25 时按控件核对实际 Note/CC 编号,
 * 不一致就改 src/midi/midiMapping.ts 顶部的编号常量。
 * 另含 MIDI Learn 入口与自定义绑定列表(见 src/midi/midiLearn.ts)。
 */

import { useState } from 'react';
import type { MidiState } from '../midi/useMidi';
import { bindingLabel, targetLabel, type MidiBinding, type MidiTarget } from '../midi/midiLearn';

export interface MidiLearnProps {
  learnMode: boolean;
  armedTarget: MidiTarget | null;
  bindings: MidiBinding[];
  onToggleLearn: () => void;
  onDisarm: () => void;
  onDeleteBinding: (index: number) => void;
  onClearBindings: () => void;
}

export function MidiStatus({ midi, learn }: { midi: MidiState; learn?: MidiLearnProps }) {
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

          {learn && (
            <div className="midi-learn-block">
              <div className="midi-learn-row">
                <button
                  className={`midi-learn-btn ${learn.learnMode ? 'active' : ''}`}
                  title="进入后点击界面上的控件,再动一下 MIDI 控制器即完成映射"
                  onClick={learn.onToggleLearn}
                >
                  {learn.learnMode ? '退出 Learn' : 'MIDI Learn'}
                </button>
                {learn.learnMode && (
                  <span className="midi-learn-armed">
                    {learn.armedTarget ? (
                      <>
                        目标:{targetLabel(learn.armedTarget)},动一下控制器…
                        <button className="midi-learn-cancel" onClick={learn.onDisarm}>
                          取消
                        </button>
                      </>
                    ) : (
                      '点击要映射的控件(旋钮/踩钉/摇杆/快照…)'
                    )}
                  </span>
                )}
              </div>
              {learn.bindings.length > 0 && (
                <div className="midi-bindings">
                  <div className="midi-bindings-title">
                    自定义绑定({learn.bindings.length})
                    <button className="midi-learn-cancel" onClick={learn.onClearBindings}>
                      清空
                    </button>
                  </div>
                  {learn.bindings.map((b, i) => (
                    <div className="midi-binding-row" key={i}>
                      <span>{bindingLabel(b)}</span>
                      <button
                        className="midi-learn-cancel"
                        title="删除该绑定"
                        onClick={() => learn.onDeleteBinding(i)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="midi-monitor-hint">
            默认映射编号不符?改 src/midi/midiMapping.ts 顶部常量;自定义绑定优先于默认映射
          </div>
        </div>
      )}
    </div>
  );
}
