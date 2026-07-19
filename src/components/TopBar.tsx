import { useRef } from 'react';
import type { InputSourceType } from '../audio/AudioEngine';
import { LevelMeter } from './LevelMeter';

interface TopBarProps {
  inputType: InputSourceType | null;
  onSelectMic: () => void;
  onSelectFile: (file: File) => void;
  onSelectTest: () => void;
  onStopInput: () => void;
  micDevices: MediaDeviceInfo[];
  micId: string;
  onMicChange: (id: string) => void;
  outputDevices: MediaDeviceInfo[];
  outputId: string;
  onOutputChange: (id: string) => void;
  outputSelectSupported: boolean;
  inputGain: number;
  onInputGain: (v: number) => void;
  masterVolume: number;
  onMasterVolume: (v: number) => void;
  globalBypass: boolean;
  onToggleBypass: () => void;
  showMeters: boolean;
  onToggleMeters: () => void;
  inputAnalyser: AnalyserNode | null;
  outputAnalyser: AnalyserNode | null;
}

/** 顶部控制台:输入源 / 输入电平 / 输出 三组,分组标签 + 竖分隔 */
export function TopBar(props: TopBarProps) {
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="top-bar">
      <div className="console-group">
        <span className="group-label">输入源</span>
        <div className="group-body">
          <div className="input-buttons">
            <button
              className={props.inputType === 'mic' ? 'active' : ''}
              onClick={props.onSelectMic}
            >
              🎙 麦克风
            </button>
            <button
              className={props.inputType === 'file' ? 'active' : ''}
              onClick={() => fileRef.current?.click()}
            >
              📂 音频文件
            </button>
            <button
              className={props.inputType === 'test' ? 'active' : ''}
              onClick={props.onSelectTest}
            >
              🎵 测试音源
            </button>
            {props.inputType && (
              <button className="stop-btn" onClick={props.onStopInput}>
                ■ 停止
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="audio/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) props.onSelectFile(f);
                e.target.value = '';
              }}
            />
          </div>
          {props.inputType === 'mic' && props.micDevices.length > 0 && (
            <select
              value={props.micId}
              onChange={(e) => props.onMicChange(e.target.value)}
            >
              {props.micDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `输入设备 ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="console-divider" />

      <div className="console-group">
        <span className="group-label">输入电平</span>
        <div className="group-body">
          <label className="gain-ctrl">
            GAIN
            <input
              type="range"
              min={0}
              max={2}
              step={0.01}
              value={props.inputGain}
              onChange={(e) => props.onInputGain(Number(e.target.value))}
            />
          </label>
          <LevelMeter analyser={props.showMeters ? props.inputAnalyser : null} label="IN" />
        </div>
      </div>

      <div className="console-divider" />

      <div className="console-group">
        <span className="group-label">输出</span>
        <div className="group-body">
          {props.outputSelectSupported && props.outputDevices.length > 0 && (
            <select
              value={props.outputId}
              onChange={(e) => props.onOutputChange(e.target.value)}
            >
              {props.outputDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `输出设备 ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          )}
          <label className="gain-ctrl">
            MASTER
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={props.masterVolume}
              onChange={(e) => props.onMasterVolume(Number(e.target.value))}
            />
          </label>
          <LevelMeter analyser={props.showMeters ? props.outputAnalyser : null} label="OUT" />
          <button
            className={props.showMeters ? 'active' : ''}
            title="显示/隐藏各级电平表"
            onClick={props.onToggleMeters}
          >
            电平表
          </button>
          <button
            className={`bypass-btn ${props.globalBypass ? 'bypassed' : ''}`}
            onClick={props.onToggleBypass}
          >
            {props.globalBypass ? '已 Bypass' : 'Bypass'}
          </button>
        </div>
      </div>
    </div>
  );
}
