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
  inputAnalyser: AnalyserNode | null;
  outputAnalyser: AnalyserNode | null;
}

/** 顶栏:输入源、输入/输出设备、增益、电平表、全局 Bypass */
export function TopBar(props: TopBarProps) {
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="top-bar">
      <div className="top-section">
        <span className="section-title">输入</span>
        <div className="input-buttons">
          <button
            className={props.inputType === 'mic' ? 'active' : ''}
            onClick={props.onSelectMic}
          >
            麦克风/线路
          </button>
          <button
            className={props.inputType === 'file' ? 'active' : ''}
            onClick={() => fileRef.current?.click()}
          >
            音频文件
          </button>
          <button
            className={props.inputType === 'test' ? 'active' : ''}
            onClick={props.onSelectTest}
          >
            测试音源
          </button>
          {props.inputType && (
            <button className="stop-btn" onClick={props.onStopInput}>
              停止
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
        <label className="gain-ctrl">
          输入增益
          <input
            type="range"
            min={0}
            max={2}
            step={0.01}
            value={props.inputGain}
            onChange={(e) => props.onInputGain(Number(e.target.value))}
          />
        </label>
        <LevelMeter analyser={props.inputAnalyser} label="IN" />
      </div>

      <div className="top-section">
        <span className="section-title">输出</span>
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
          主音量
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={props.masterVolume}
            onChange={(e) => props.onMasterVolume(Number(e.target.value))}
          />
        </label>
        <LevelMeter analyser={props.outputAnalyser} label="OUT" />
        <button
          className={`bypass-btn ${props.globalBypass ? 'bypassed' : ''}`}
          onClick={props.onToggleBypass}
        >
          {props.globalBypass ? '已 Bypass' : 'Bypass'}
        </button>
      </div>
    </div>
  );
}
