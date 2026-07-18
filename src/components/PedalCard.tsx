import type { ChainItem } from '../state/store';
import type { EffectDefinition } from '../audio/effects/types';

interface PedalCardProps {
  item: ChainItem;
  def: EffectDefinition;
  onToggle: (uid: string) => void;
  onRemove: (uid: string) => void;
  onParam: (uid: string, key: string, value: number) => void;
}

function formatValue(v: number, unit?: string): string {
  const s = Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
  return unit ? `${s} ${unit}` : s;
}

/** 单块效果器卡片:电源开关、参数滑杆、删除 */
export function PedalCard({ item, def, onToggle, onRemove, onParam }: PedalCardProps) {
  return (
    <div
      className={`pedal ${item.enabled ? 'pedal-on' : 'pedal-off'}`}
      style={{ borderTopColor: def.color }}
    >
      <div className="pedal-header">
        <span className={`pedal-led ${item.enabled ? 'led-on' : ''}`} />
        <span className="pedal-name">{def.name}</span>
        <button
          className="pedal-remove"
          title="移除"
          onClick={() => onRemove(item.uid)}
        >
          ×
        </button>
      </div>

      <div className="pedal-params">
        {def.params.map((p) => (
          <div className="pedal-param" key={p.key}>
            <label>
              {p.label}
              <span className="param-value">
                {formatValue(item.values[p.key] ?? p.defaultValue, p.unit)}
              </span>
            </label>
            <input
              type="range"
              min={p.min}
              max={p.max}
              step={p.step}
              value={item.values[p.key] ?? p.defaultValue}
              disabled={!item.enabled}
              onChange={(e) => onParam(item.uid, p.key, Number(e.target.value))}
            />
          </div>
        ))}
      </div>

      <button
        className={`pedal-switch ${item.enabled ? 'switch-on' : ''}`}
        onClick={() => onToggle(item.uid)}
      >
        {item.enabled ? 'ON' : 'OFF'}
      </button>
    </div>
  );
}
