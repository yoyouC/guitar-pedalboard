import { useEffect, useState } from 'react';
import { audioEngine } from '../audio/AudioEngine';
import {
  INITIAL_LOOPER_STATUS,
  MAX_LOOP_SECONDS,
  formatLooperTime,
  type LooperStatus,
} from '../audio/looperState';

interface LooperPanelProps {
  engineReady: boolean;
  hasInput: boolean;
}

const PHASE_LABEL: Record<LooperStatus['phase'], string> = {
  empty: '待机',
  recording: '初录',
  playing: '播放',
  overdubbing: '叠录',
  stopped: '暂停',
};

/** 单轨 Looper：初录 → 循环播放 → 多次叠录，可撤销最后一次叠录。 */
export function LooperPanel({ engineReady, hasInput }: LooperPanelProps) {
  const [status, setStatus] = useState<LooperStatus>(INITIAL_LOOPER_STATUS);
  const [level, setLevel] = useState(1);

  useEffect(() => audioEngine.subscribeLooper(setStatus), [engineReady]);

  const handlePrimary = () => {
    switch (status.phase) {
      case 'empty':
        audioEngine.startLoopRecording();
        break;
      case 'recording':
        audioEngine.finishLoopRecording();
        break;
      case 'playing':
      case 'stopped':
        audioEngine.startLoopOverdub();
        break;
      case 'overdubbing':
        audioEngine.finishLoopOverdub();
        break;
    }
  };

  const primaryLabel =
    status.phase === 'recording' || status.phase === 'overdubbing'
      ? '■ 完成'
      : status.phase === 'empty'
        ? '● 初录'
        : '＋ 叠录';
  const isWriting =
    status.phase === 'recording' || status.phase === 'overdubbing';
  const hasLoop = status.phase !== 'empty' && status.phase !== 'recording';
  const progress = status.phase === 'recording'
    ? Math.min(100, (status.lengthSeconds / MAX_LOOP_SECONDS) * 100)
    : status.lengthSeconds > 0
      ? Math.min(100, (status.positionSeconds / status.lengthSeconds) * 100)
      : 0;

  return (
    <div className="console-group looper-group">
      <span className="group-label">LOOPER · {PHASE_LABEL[status.phase]}</span>
      <div className="group-body looper-body">
        <button
          className={`looper-primary ${isWriting ? 'writing' : ''}`}
          data-midi-target="looper-record"
          disabled={
            !engineReady ||
            !status.available ||
            (status.phase === 'empty' && !hasInput)
          }
          title={
            status.available
              ? '初录后自动循环；播放中可叠录'
              : '请先选择输入源以初始化音频引擎'
          }
          onClick={handlePrimary}
        >
          {primaryLabel}
        </button>
        <button
          disabled={!hasLoop || status.phase === 'overdubbing'}
          title={status.phase === 'stopped' ? '继续循环' : '暂停循环'}
          data-midi-target="looper-play"
          onClick={() => audioEngine.toggleLoopPlayback()}
        >
          {status.phase === 'stopped' ? '▶' : 'Ⅱ'}
        </button>
        <button
          disabled={!status.canUndo || isWriting}
          title="撤销最后一次叠录"
          onClick={() => audioEngine.undoLoopOverdub()}
        >
          ↶
        </button>
        <button
          className="looper-clear"
          disabled={status.phase === 'empty'}
          title="清空循环"
          data-midi-target="looper-clear"
          onClick={() => audioEngine.clearLoop()}
        >
          清空
        </button>
        <span className="looper-time">
          {formatLooperTime(
            status.phase === 'recording'
              ? status.lengthSeconds
              : status.positionSeconds,
          )}
          {status.phase !== 'recording' &&
            status.lengthSeconds > 0 &&
            ` / ${formatLooperTime(status.lengthSeconds)}`}
        </span>
        <div className="looper-progress" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </div>
        <label className="looper-level" title="循环回放音量">
          LOOP
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.01}
            value={level}
            onChange={(event) => {
              const next = Number(event.target.value);
              setLevel(next);
              audioEngine.setLoopLevel(next);
            }}
          />
        </label>
        {status.message && <span className="looper-message">{status.message}</span>}
      </div>
    </div>
  );
}
