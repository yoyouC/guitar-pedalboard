import { AMP_REGISTRY } from '../audio/amps';
import type { EffectDefinition } from '../audio/effects/types';
import { Knob } from './Knob';

interface AmpPanelProps {
  ampId: string;
  enabled: boolean;
  values: Record<string, number>;
  onSelect: (ampId: string) => void;
  onToggle: () => void;
  onParam: (key: string, value: number) => void;
}

function getDef(ampId: string): EffectDefinition {
  return AMP_REGISTRY.find((d) => d.id === ampId) ?? AMP_REGISTRY[0];
}

/** 箱头模拟面板:型号选择 + 拟物箱头(tolex 外壳 + 旋钮排 + 电源开关) */
export function AmpPanel({ ampId, enabled, values, onSelect, onToggle, onParam }: AmpPanelProps) {
  const def = getDef(ampId);

  return (
    <div className="amp-section">
      <div className="amp-selector">
        <span className="section-title">箱头模拟</span>
        {AMP_REGISTRY.map((d) => (
          <button
            key={d.id}
            className={`amp-tab ${d.id === ampId ? 'active' : ''}`}
            onClick={() => onSelect(d.id)}
          >
            {d.name}
          </button>
        ))}
      </div>

      <div className={`amp-head ${enabled ? 'amp-on' : 'amp-off'}`}>
        <div className="amp-top">
          <span className="amp-brand">{def.name}</span>
          <span className={`amp-jewel ${enabled ? 'jewel-on' : ''}`} />
        </div>

        <div className="amp-faceplate">
          <div className="amp-knobs">
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
          </div>

          <button
            className={`amp-power ${enabled ? 'power-on' : ''}`}
            title={enabled ? '关闭箱头(直通)' : '开启箱头'}
            onClick={onToggle}
          >
            <span className="amp-power-lever" />
            <span className="amp-power-label">{enabled ? 'ON' : 'OFF'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
