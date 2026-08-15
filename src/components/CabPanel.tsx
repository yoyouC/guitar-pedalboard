import { CAB_REGISTRY } from '../audio/cabs';
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

  return (
    <div className="cab-section">
      <div className="cab-selector">
        <span className="section-title">箱体模拟</span>
        {CAB_REGISTRY.map((d) => (
          <button
            key={d.id}
            className={`cab-tab ${d.id === cabId ? 'active' : ''}`}
            onClick={() => rigStore.setCab(d.id)}
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
    </div>
  );
}
