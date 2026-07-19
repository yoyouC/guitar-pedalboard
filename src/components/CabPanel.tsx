import { CAB_REGISTRY } from '../audio/cabs';
import type { EffectDefinition } from '../audio/effects/types';
import { Knob } from './Knob';
import { MiniMeter } from './MiniMeter';

interface CabPanelProps {
  cabId: string;
  enabled: boolean;
  values: Record<string, number>;
  analyser: AnalyserNode | null;
  showMeters: boolean;
  onSelect: (cabId: string) => void;
  onToggle: () => void;
  onParam: (key: string, value: number) => void;
}

function getDef(cabId: string): EffectDefinition {
  return CAB_REGISTRY.find((d) => d.id === cabId) ?? CAB_REGISTRY[0];
}

/** 箱体模拟面板:型号选择 + 箱体外观(网罩 + LEVEL 旋钮 + DI 直通开关) */
export function CabPanel({ cabId, enabled, values, analyser, showMeters, onSelect, onToggle, onParam }: CabPanelProps) {
  const def = getDef(cabId);

  return (
    <div className="cab-section">
      <div className="cab-selector">
        <span className="section-title">箱体模拟</span>
        {CAB_REGISTRY.map((d) => (
          <button
            key={d.id}
            className={`cab-tab ${d.id === cabId ? 'active' : ''}`}
            onClick={() => onSelect(d.id)}
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
              onChange={(v) => onParam(p.key, v)}
            />
          ))}
          <button
            className={`cab-power ${enabled ? 'power-on' : ''}`}
            title={enabled ? '关闭箱体(DI 直通)' : '开启箱体'}
            onClick={onToggle}
          >
            {enabled ? 'CAB ON' : 'DI 直通'}
          </button>
        </div>
      </div>
    </div>
  );
}
