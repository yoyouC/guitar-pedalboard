import { useRef, useSyncExternalStore } from 'react';
import { CAB_REGISTRY, CAB_SELECTOR_REGISTRY } from '../audio/cabs';
import { cabIrService } from '../audio/cabIrService';
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

/** 四个内置 DSP 箱体；Custom IR 标签本身就是 WAV 选择入口。 */
export function CabPanel({ showMeters, engineReady }: CabPanelProps) {
  const cabId = useRig((s) => s.cabId);
  const enabled = useRig((s) => s.cabEnabled);
  const values = useRig((s) => s.cabValues);
  // 图谱重建后重读引擎侧电平表节点引用
  useRig((s) => s.graphVersion);
  const def = getDef(cabId);
  const analyser = engineReady ? audioEngine.cabAnalyser : null;
  const fileInput = useRef<HTMLInputElement>(null);
  const irState = useSyncExternalStore(cabIrService.subscribe, cabIrService.getState);

  const selectCab = (id: string) => {
    if (id === 'customIr') {
      fileInput.current?.click();
      return;
    }
    void cabIrService.select({
      kind: 'builtin',
      id: id as 'open1x12' | 'blue2x12' | 'gb4x12' | 'v304x12',
    });
  };

  return (
    <div className="cab-section">
      <div className="cab-selector">
        <span className="section-title">箱体模拟</span>
        {CAB_SELECTOR_REGISTRY.map((d) => (
          <button
            key={d.id}
            className={`cab-tab ${d.id === cabId ? 'active' : ''}`}
            disabled={irState.status === 'loading'}
            onClick={() => selectCab(d.id)}
          >
            {d.name}
          </button>
        ))}
        <input
          ref={fileInput}
          className="cab-ir-file"
          type="file"
          accept=".wav,audio/wav,audio/x-wav"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (!file) return;
            void cabIrService.importFile(file).then((result) => {
              if (!result.ok) window.alert(result.message);
            });
          }}
        />
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

    </div>
  );
}
