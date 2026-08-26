import { useState } from 'react';
import { createPortal } from 'react-dom';
import { audioEngine, type InputSourceType } from '../audio/AudioEngine';
import {
  AUDIO_PROFILES,
  audioProfileDefinition,
  type AudioProfile,
} from '../audio/audioProfile';
import {
  createDiagnosticExport,
  latencyBand,
  type AudioDiagnosticsSnapshot,
} from '../audio/audioDiagnostics';
import { rigStore } from '../state/useRig';

interface AudioDiagnosticsPanelProps {
  diagnostics: AudioDiagnosticsSnapshot;
  engineReady: boolean;
  inputType: InputSourceType | null;
  inputDeviceLabel?: string;
  outputDeviceLabel?: string;
  reduceVisualLoad: boolean;
  onReduceVisualLoadChange: (enabled: boolean) => void;
}

const formatMs = (value: number | null, digits = 1) =>
  value === null ? '不可用' : `${value.toFixed(digits)} ms`;

function clientInfo(): { browser: string; os: string } {
  const ua = navigator.userAgent;
  const browser =
    ua.match(/Edg\/(\d+)/)?.[1] ? `Edge ${ua.match(/Edg\/(\d+)/)![1]}` :
    ua.match(/Chrome\/(\d+)/)?.[1] ? `Chrome ${ua.match(/Chrome\/(\d+)/)![1]}` :
    ua.match(/Firefox\/(\d+)/)?.[1] ? `Firefox ${ua.match(/Firefox\/(\d+)/)![1]}` :
    ua.match(/Version\/(\d+).+Safari/)?.[1] ? `Safari ${ua.match(/Version\/(\d+).+Safari/)![1]}` : '未知浏览器';
  const os = /Windows/i.test(ua) ? 'Windows' : /Mac OS|Macintosh/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : '未知系统';
  return { browser, os };
}

function rigComplexity() {
  const state = rigStore.getState();
  const ids = [...state.chain.map((item) => item.effectId), state.ampId, state.cabId];
  return {
    pedals: state.chain.length,
    namModules: ids.filter((id) => id.includes('nam') || id.includes('tone3000')).length,
    wdfModules: ids.filter((id) => id.includes('wdf')).length,
  };
}

function downloadJson(value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `guitar-pedalboard-audio-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AudioDiagnosticsPanel(props: AudioDiagnosticsPanelProps) {
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [includeDeviceNames, setIncludeDeviceNames] = useState(false);
  const [observing, setObserving] = useState(false);
  const [message, setMessage] = useState('');
  const d = props.diagnostics;
  const median = d.outputEstimate.medianMs;
  const inputSettings = d.inputSettings as (MediaTrackSettings & { latency?: number }) | null;
  const requestedInputLatencyMs = audioProfileDefinition(d.profile).inputLatencySeconds * 1000;

  const switchProfile = async (profile: AudioProfile) => {
    if (profile === d.profile) return;
    if (props.engineReady && !window.confirm(`切换到“${audioProfileDefinition(profile).label}”会短暂重建音频设备。继续吗？`)) return;
    setSwitching(true);
    setMessage('');
    const result = await audioEngine.switchAudioProfile(profile);
    setSwitching(false);
    setMessage(result.ok ? '音频档位已切换。' : result.message ?? '切换失败。');
  };

  const calibrate = async () => {
    if (!window.confirm('仅限电气回环：请先降低监听音量，用线缆将当前输出连接到当前输入；不要把扬声器对着麦克风。测试信号约为 -30 dBFS。确认开始？')) return;
    setMessage('正在测量电气往返时延…');
    try {
      const result = await audioEngine.runLoopbackCalibration();
      setMessage(result.ok ? `校准完成：${formatMs(result.delayMs)}，置信度 ${Math.round(result.confidence * 100)}%。` : `校准无效（${result.reason ?? '未知原因'}），未保存结果。`);
    } catch (error) {
      setMessage(`校准失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const exportDiagnostics = () => {
    const info = clientInfo();
    downloadJson(createDiagnosticExport({
      snapshot: d,
      appVersion: '0.0.1',
      ...info,
      rigComplexity: rigComplexity(),
      includeDeviceNames,
      inputDeviceLabel: props.inputDeviceLabel,
      outputDeviceLabel: props.outputDeviceLabel,
    }));
  };

  const observeStability = async () => {
    setObserving(true);
    setMessage('正在观察当前 Rig 10 秒；不会自动改档、降质或旁路效果。');
    try {
      const result = await audioEngine.runStabilityObservation();
      setMessage(`观察完成：长任务 ${result.longTaskCount ?? '浏览器不提供'}；underrun ${result.underrunEvents ?? '浏览器不提供'}。`);
    } catch (error) {
      setMessage(`观察失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setObserving(false);
    }
  };

  return (
    <>
      <button
        className={`latency-pill latency-${latencyBand(median)}`}
        title="打开音频诊断；数值是浏览器报告的输出估算，并非物理往返时延"
        onClick={() => setOpen(true)}
      >
        ≈ {formatMs(median)} · {audioProfileDefinition(d.profile).label} · {d.sampleRate ? `${Math.round(d.sampleRate / 1000)}k` : '—'}
      </button>
      {open && createPortal((
        <div className="audio-diagnostics-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <section className="audio-diagnostics-modal" role="dialog" aria-modal="true" aria-labelledby="audio-diagnostics-title">
            <button className="audio-diagnostics-close" aria-label="关闭" onClick={() => setOpen(false)}>×</button>
            <h2 id="audio-diagnostics-title">音频时延与稳定性</h2>
            <p className="diagnostics-note">三类数字口径不同，不相加：输出估算来自浏览器；Rig 链路来自模块元数据；物理往返只来自电气回环校准。</p>

            <label className="diagnostics-profile">
              音频档位
              <select value={d.profile} disabled={switching} onChange={(event) => void switchProfile(event.target.value as AudioProfile)}>
                {AUDIO_PROFILES.map((profile) => <option key={profile.id} value={profile.id}>{profile.label} — {profile.description}</option>)}
              </select>
            </label>

            {d.warning && <p className="diagnostics-warning">⚠ {d.warning}</p>}
            <dl className="diagnostics-grid">
              <dt>输出估算（中位）</dt><dd className={`latency-text-${latencyBand(median)}`}>{formatMs(median)}</dd>
              <dt>最近 5 次范围</dt><dd>{d.outputEstimate.samples ? `${formatMs(d.outputEstimate.minMs)} – ${formatMs(d.outputEstimate.maxMs)}` : '不可用'}</dd>
              <dt>baseLatency</dt><dd>{formatMs(d.baseLatencyMs)}</dd>
              <dt>outputLatency</dt><dd>{formatMs(d.outputLatencyMs)}</dd>
              <dt>实际采样率</dt><dd>{d.sampleRate ? `${d.sampleRate} Hz` : '不可用'}</dd>
              <dt>Worklet</dt><dd>{d.workletFailures.length ? `未加载：${d.workletFailures.join('、')}` : d.ready ? '全部已注册' : '尚未启动'}</dd>
              <dt>请求参数</dt><dd>输出 {audioProfileDefinition(d.profile).latencyHint} · 48kHz · mono · 输入 {requestedInputLatencyMs}ms ideal · EC/NS/AGC 关闭</dd>
              <dt>输入轨实际参数</dt><dd>{inputSettings ? `${inputSettings.sampleRate ?? '—'} Hz · ${inputSettings.channelCount ?? '—'} ch · latency ${formatMs(typeof inputSettings.latency === 'number' ? inputSettings.latency * 1000 : null)}` : '不可用'}</dd>
              <dt>语音处理实际值</dt><dd>{inputSettings ? `EC ${String(inputSettings.echoCancellation ?? '—')} · NS ${String(inputSettings.noiseSuppression ?? '—')} · AGC ${String(inputSettings.autoGainControl ?? '—')}` : '不可用'}</dd>
              <dt>Rig 处理时延</dt><dd>{formatMs(d.rigLatency?.processingMs ?? null, 2)}</dd>
              <dt>Rig 设计时延</dt><dd>{formatMs(d.rigLatency?.designMs ?? null, 2)}</dd>
              <dt>电气往返实测</dt><dd>{d.calibrationMs === null ? '不可用（未校准或环境变化，请重测）' : formatMs(d.calibrationMs)}</dd>
              <dt>Underrun</dt><dd>{d.playback.supported ? `${d.playback.underrunEvents ?? 0} 次 / ${formatMs(d.playback.underrunDurationMs)}` : '浏览器不提供 playbackStats'}</dd>
              <dt>Playback latency 统计</dt><dd>{d.playback.supported ? `平均 ${formatMs(d.playback.averageLatencyMs)} · 最小 ${formatMs(d.playback.minimumLatencyMs)} · 最大 ${formatMs(d.playback.maximumLatencyMs)}` : '浏览器不提供 playbackStats'}</dd>
              <dt>主线程长任务</dt><dd>{d.mainThread.supported ? `${d.mainThread.longTaskCount} 次 / ${formatMs(d.mainThread.longTaskDurationMs)}` : '浏览器不提供 Long Tasks API'}</dd>
              <dt>最近稳定性观察</dt><dd>{d.stabilityObservation ? `${Math.round(d.stabilityObservation.durationMs / 1000)}s · 长任务 ${d.stabilityObservation.longTaskCount ?? '不可用'} · underrun ${d.stabilityObservation.underrunEvents ?? '不可用'}` : '尚未运行'}</dd>
            </dl>

            <details>
              <summary>当前路径明细</summary>
              {d.rigLatency?.items.length ? <ul>{d.rigLatency.items.map((item) => <li key={item.id}>{item.name}: 处理 {item.processingSamples} samples，设计 {item.designSamples} samples</li>)}</ul> : <p>当前直接监听路径没有已声明的模块时延。</p>}
            </details>

            <div className="diagnostics-actions">
              <button disabled={!props.engineReady || props.inputType !== 'mic'} onClick={() => void calibrate()}>电气回环校准</button>
              <button disabled={!props.engineReady || observing} onClick={() => void observeStability()}>{observing ? '观察中…' : '观察当前 Rig 10 秒'}</button>
              <label><input type="checkbox" checked={props.reduceVisualLoad} onChange={(event) => props.onReduceVisualLoadChange(event.target.checked)} /> 降低视觉负载</label>
            </div>
            <p className="diagnostics-note">DSP 音质档位：当前没有通过听感、频响与稳定性验证的 Full/Lite 变体，因此不展示无效选项。</p>

            <div className="diagnostics-export">
              <label><input type="checkbox" checked={includeDeviceNames} onChange={(event) => setIncludeDeviceNames(event.target.checked)} /> 导出时包含设备名称</label>
              <button onClick={exportDiagnostics}>导出诊断 JSON</button>
            </div>
            {message && <p role="status" className="diagnostics-message">{message}</p>}
          </section>
        </div>
      ), document.body)}
    </>
  );
}
