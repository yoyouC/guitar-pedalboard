import type { ChainItem } from '../state/store';
import type { EffectDefinition } from '../audio/effects/types';
import { Knob } from './Knob';

interface PedalCardProps {
  item: ChainItem;
  def: EffectDefinition;
  onToggle: (uid: string) => void;
  onRemove: (uid: string) => void;
  onParam: (uid: string, key: string, value: number) => void;
}

/** 拟物单块效果器:金属外壳 + 旋钮 + 脚踏开关 */
export function PedalCard({ item, def, onToggle, onRemove, onParam }: PedalCardProps) {
  return (
    <div
      className={`pedal ${item.enabled ? 'pedal-on' : 'pedal-off'}`}
      style={{ '--pedal-color': def.color } as React.CSSProperties}
    >
      <span className="screw screw-tl" />
      <span className="screw screw-tr" />
      <span className="screw screw-bl" />
      <span className="screw screw-br" />

      <button
        className="pedal-remove"
        title="移除"
        onClick={() => onRemove(item.uid)}
      >
        ×
      </button>

      <div className="pedal-nameplate">
        <span className="pedal-name">{def.name}</span>
      </div>

      <div className="pedal-led-row">
        <span className={`pedal-led-bezel ${item.enabled ? 'led-on' : ''}`}>
          <span className="pedal-led" />
        </span>
      </div>

      <div className="pedal-knobs">
        {def.params.map((p) => (
          <Knob
            key={p.key}
            value={item.values[p.key] ?? p.defaultValue}
            min={p.min}
            max={p.max}
            step={p.step}
            defaultValue={p.defaultValue}
            label={p.label}
            unit={p.unit}
            disabled={!item.enabled}
            onChange={(v) => onParam(item.uid, p.key, v)}
          />
        ))}
      </div>

      <button
        className={`footswitch ${item.enabled ? 'fs-on' : ''}`}
        title={item.enabled ? '踩下以关闭' : '踩下以开启'}
        onClick={() => onToggle(item.uid)}
      >
        <span className="footswitch-cap" />
      </button>
    </div>
  );
}
