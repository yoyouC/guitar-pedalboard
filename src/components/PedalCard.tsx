import type { ChainItem } from '../state/store';
import type { EffectDefinition } from '../audio/effects/types';
import { Knob } from './Knob';
import { MiniMeter } from './MiniMeter';
import { WahTreadle } from './WahTreadle';

/** 用摇杆(WahTreadle)代替 position 旋钮的效果器 */
const TREADLE_EFFECT_IDS = new Set(['wahpedal', 'crybabywdf', 'whammy']);

interface PedalCardProps {
  item: ChainItem;
  def: EffectDefinition;
  analyser: AnalyserNode | null;
  showMeters: boolean;
  onToggle: (uid: string) => void;
  onRemove: (uid: string) => void;
  onParam: (uid: string, key: string, value: number) => void;
  onToggleSlot: (uid: string) => void;
}

/** 拟物单块效果器:金属外壳 + 旋钮 + 脚踏开关 */
export function PedalCard({ item, def, analyser, showMeters, onToggle, onRemove, onParam, onToggleSlot }: PedalCardProps) {
  return (
    <div
      className={`pedal skin-${def.id} ${item.enabled ? 'pedal-on' : 'pedal-off'}`}
      style={{ '--pedal-color': def.color } as React.CSSProperties}
    >
      <span className="screw screw-tl" />
      <span className="screw screw-tr" />
      <span className="screw screw-bl" />
      <span className="screw screw-br" />

      <button
        className="pedal-slot-toggle"
        title={item.post ? '移到箱头前(前置)' : '移到箱头后(FX Loop)'}
        onClick={() => onToggleSlot(item.uid)}
      >
        ⇄
      </button>
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
        {item.enabled && showMeters && <MiniMeter analyser={analyser} />}
      </div>

      <div className="pedal-knobs">
        {def.params
          .filter((p) => !(TREADLE_EFFECT_IDS.has(def.id) && p.key === 'position'))
          .map((p) => (
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

      {TREADLE_EFFECT_IDS.has(def.id) && (
        <WahTreadle
          value={item.values['position'] ?? def.params.find((p) => p.key === 'position')?.defaultValue ?? 50}
          disabled={!item.enabled}
          onChange={(v) => onParam(item.uid, 'position', v)}
          badge={def.id === 'whammy' ? 'WHAMMY' : 'WAH'}
          resetValue={def.id === 'whammy' ? 0 : 50}
          formatValue={
            def.id === 'whammy'
              ? (v) => {
                  const range = item.values['range'] ?? 2;
                  const st = ((v / 100) * range).toFixed(1);
                  return `${v}% · ${Number(st) > 0 ? '+' : ''}${st}st`;
                }
              : undefined
          }
        />
      )}

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
