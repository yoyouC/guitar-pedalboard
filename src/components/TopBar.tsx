import { useEffect, useRef, useState } from 'react';
import type { InputSourceType } from '../audio/AudioEngine';
import { audioEngine } from '../audio/AudioEngine';
import { INPUT_TARGET_DB } from '../audio/level';
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
  /** 引擎已初始化(用户手势后),录音按钮才可用 */
  engineReady: boolean;
}

/** 录音时长 mm:ss */
function formatRecordTime(seconds: number): string {
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** 顶部控制台:输入源 / 输入电平 / 输出 / 录音 四组,分组标签 + 竖分隔 */
export function TopBar(props: TopBarProps) {
  const fileRef = useRef<HTMLInputElement>(null);

  // 录音状态在 React 侧管理;引擎只提供流(start/stopRecording)
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recordTimerRef = useRef<number | null>(null);

  const stopRecordTimer = () => {
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
  };

  // 卸载时停表(引擎录音随停止按钮或页面关闭结束)
  useEffect(() => stopRecordTimer, []);

  const handleRecordToggle = () => {
    if (recording) {
      audioEngine.stopRecording(); // 停止后引擎自动触发下载
      setRecording(false);
      stopRecordTimer();
      return;
    }
    if (!audioEngine.startRecording()) return; // 引擎未就绪
    setRecordSeconds(0);
    setRecording(true);
    recordTimerRef.current = window.setInterval(() => setRecordSeconds((s) => s + 1), 1000);
  };

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
          <LevelMeter
            analyser={props.showMeters ? props.inputAnalyser : null}
            label="IN"
            targetBandDb={INPUT_TARGET_DB}
          />
          <span className="gain-hint" title="输入校准:用力弹奏并调 GAIN,让峰值刻度进入绿色目标带">
            峰值进绿区
          </span>
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

      <div className="console-divider" />

      <div className="console-group">
        <span className="group-label">录音</span>
        <div className="group-body">
          <button
            className={`record-btn ${recording ? 'recording' : ''}`}
            disabled={!props.engineReady && !recording}
            title={
              props.engineReady
                ? '录制输出(webm/opus),停止后自动下载'
                : '请先选择一个输入源'
            }
            onClick={handleRecordToggle}
          >
            {recording ? '■ 停止' : '● 录音'}
          </button>
          {recording && <span className="record-time">{formatRecordTime(recordSeconds)}</span>}
        </div>
      </div>
    </div>
  );
}
