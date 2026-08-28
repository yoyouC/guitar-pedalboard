import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CAB_REGISTRY, CAB_SELECTOR_REGISTRY } from '../audio/cabs';
import { CAB_IR_ASSETS_READY, BUILTIN_CAB_IR_MANIFEST } from '../audio/cabIrManifest';
import { cabIrService, type CabIrServiceState } from '../audio/cabIrService';
import type { EffectDefinition } from '../audio/effects/types';
import { audioEngine } from '../audio/AudioEngine';
import { rigStore, useRig } from '../state/useRig';
import { Knob } from './Knob';
import { MiniMeter } from './MiniMeter';

interface CabPanelProps {
  showMeters: boolean;
  engineReady: boolean;
}

function getDef(cabId: string): EffectDefinition {
  return CAB_REGISTRY.find((d) => d.id === cabId) ?? CAB_REGISTRY[0];
}

/** 箱体模拟面板:型号选择 + 箱体外观(网罩 + LEVEL 旋钮 + DI 直通开关) */
export function CabPanel({ showMeters, engineReady }: CabPanelProps) {
  const cabId = useRig((s) => s.cabId);
  const enabled = useRig((s) => s.cabEnabled);
  const values = useRig((s) => s.cabValues);
  // 图谱重建后重读引擎侧电平表节点引用
  useRig((s) => s.graphVersion);
  const def = getDef(cabId);
  const analyser = engineReady ? audioEngine.cabAnalyser : null;
  const fileInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const emptyIrState = useMemo<CabIrServiceState>(
    () => ({ status: 'idle', message: null, library: [], active: null }),
    [],
  );
  const irState = useSyncExternalStore(
    cabIrService?.subscribe ?? (() => () => {}),
    cabIrService?.getState ?? (() => emptyIrState),
  );
  useEffect(() => {
    if (CAB_IR_ASSETS_READY && cabIrService) void cabIrService.refresh();
  }, []);
  const visibleLibrary = irState.library.filter((record) =>
    record.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );

  const selectCab = (id: string) => {
    if (!CAB_IR_ASSETS_READY || !cabIrService) {
      return;
    }
    if (id === 'customIr') {
      if (irState.active) void cabIrService.select({ kind: 'custom', hash: irState.active.hash });
      else fileInput.current?.click();
      return;
    }
    void cabIrService.select({ kind: 'builtin', id: id as 'open1x12' | 'blue2x12' | 'gb4x12' | 'v304x12' });
  };

  return (
    <div className="cab-section">
      <div className="cab-selector">
        <span className="section-title">箱体模拟</span>
        {CAB_SELECTOR_REGISTRY.map((d) => (
          <button
            key={d.id}
            className={`cab-tab ${d.id === cabId ? 'active' : ''}`}
            disabled={irState.status === 'loading' || !CAB_IR_ASSETS_READY || !cabIrService}
            onClick={() => selectCab(d.id)}
          >
            {d.name}
          </button>
        ))}
      </div>

      <div className={`cab-box cab-${cabId} ${enabled ? 'cab-on' : 'cab-off'}`}>
        <div className="cab-grill">
          <span className="cab-badge">{def.name}</span>
        </div>
        <div className="cab-controls">
          {enabled && showMeters && <MiniMeter analyser={analyser} />}
          {def.params.map((p) => (
            <Knob
              key={p.key}
              value={values[p.key] ?? p.defaultValue}
              min={p.min}
              max={p.max}
              step={p.step}
              defaultValue={p.defaultValue}
              label={p.label}
              unit={p.unit}
              disabled={!enabled}
              onChange={(v) => rigStore.setCabParam(p.key, v)}
            />
          ))}
          <button
            className={`cab-power ${enabled ? 'power-on' : ''}`}
            title={enabled ? '关闭箱体(DI 直通)' : '开启箱体'}
            onClick={() => rigStore.setCabEnabled(!enabled)}
          >
            {enabled ? 'CAB ON' : 'DI 直通'}
          </button>
        </div>
      </div>

      {CAB_IR_ASSETS_READY && cabIrService && (
        <div className="cab-ir-library">
          <input
            ref={fileInput}
            className="cab-ir-file"
            type="file"
            accept=".wav,audio/wav,audio/x-wav"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) void cabIrService!.importFile(file);
            }}
          />
          <div className="cab-ir-actions">
            <button onClick={() => fileInput.current?.click()} disabled={irState.status === 'loading'}>
              {irState.status === 'loading' ? '正在准备 IR…' : '导入 / 更换 WAV IR'}
            </button>
            <input
              type="search"
              value={query}
              placeholder="搜索本机 IR"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {irState.message && <div className={`cab-ir-state ${irState.status}`}>{irState.message}</div>}
          {cabId === 'customIr' && irState.active && (
            <div className="cab-ir-meta">
              <strong>{irState.active.name}</strong>
              <span>{irState.status === 'ready' ? '就绪' : '正在准备'}</span>
              <span>仅本机</span>
              <span>{irState.active.channels === 1 ? 'Mono' : 'Stereo'}</span>
              <span>{irState.active.originalSampleRate.toLocaleString()} Hz</span>
              <span>{(irState.active.durationSeconds * 1000).toFixed(1)} ms</span>
              <span>裁剪 {irState.active.trimmedFrames} frames</span>
            </div>
          )}
          {visibleLibrary.length > 0 && (
            <div className="cab-ir-list">
              {visibleLibrary.map((record) => (
                <div key={record.hash} className="cab-ir-row">
                  <button onClick={() => void cabIrService!.select({ kind: 'custom', hash: record.hash })}>
                    {record.name}
                  </button>
                  <button className="cab-ir-delete" onClick={() => void cabIrService!.delete(record.hash)}>
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
          {cabId !== 'customIr' && (() => {
            const entry = BUILTIN_CAB_IR_MANIFEST.find((candidate) => candidate.id === cabId);
            return entry ? (
              <div className="cab-ir-meta">
                <strong>{entry.name}</strong>
                <span>就绪</span>
                <span>{entry.channels === 1 ? 'Mono' : 'Stereo'}</span>
                <span>{entry.sampleRate.toLocaleString()} Hz / {entry.bitsPerSample}-bit</span>
                <span>{(entry.durationSeconds * 1000).toFixed(1)} ms</span>
                <span>裁剪 {entry.trimmedFrames} frames</span>
                <a href={entry.sourceUrl ?? undefined} target="_blank" rel="noreferrer">Tone Factor 来源</a>
                <span>{entry.license}</span>
                <span>{entry.attribution}</span>
                <span>{entry.captureDescription}</span>
              </div>
            ) : null;
          })()}
        </div>
      )}
    </div>
  );
}
