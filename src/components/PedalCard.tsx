import type { ChainItem } from '../state/store';
import type { EffectDefinition } from '../audio/effects/types';
import { Knob } from './Knob';
import { MiniMeter } from './MiniMeter';
import { WahTreadle } from './WahTreadle';
import type { Tone3000TargetState } from '../tone3000/rigIntegration';
import type { Tone3000ModelListProgress } from '../tone3000/client';
import { Tone3000ModelAttribution } from './Tone3000Display';
import { tone3000ModelListProgressText } from '../tone3000/modelListProgressPresentation';

/** 用摇杆(WahTreadle)代替 position 旋钮的效果器 */
const TREADLE_EFFECT_IDS = new Set(['wahpedal', 'crybabywdf', 'whammy']);

interface PedalCardProps {
  item: ChainItem;
  def: EffectDefinition;
  /** 链上索引(0 起,MIDI Learn 目标定位用) */
  index: number;
  analyser: AnalyserNode | null;
  showMeters: boolean;
  onToggle: (uid: string) => void;
  onRemove: (uid: string) => void;
  onParam: (uid: string, key: string, value: number) => void;
  onToggleSlot: (uid: string) => void;
  tone3000State?: Tone3000TargetState;
  tone3000ModelListProgress?: Tone3000ModelListProgress;
  onReplaceTone3000?: (uid: string) => void;
  onSwitchTone3000ModelVariant?: (uid: string) => void;
  onRepairTone3000?: (uid: string) => void;
}

/** 拟物单块效果器:金属外壳 + 旋钮 + 脚踏开关 */
export function PedalCard({ item, def, index, analyser, showMeters, onToggle, onRemove, onParam, onToggleSlot, tone3000State, tone3000ModelListProgress, onReplaceTone3000, onSwitchTone3000ModelVariant, onRepairTone3000 }: PedalCardProps) {
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
            <span key={p.key} data-midi-target={`pedal-param:${index}:${p.key}`}>
              <Knob
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
            </span>
          ))}
      </div>

      {item.effectId === 'tone3000Nam' && (
        <div className="tone3000-pedal-meta">
          <Tone3000ModelAttribution
            info={tone3000State?.info}
            fallback={item.modelRef ?? 'TONE3000 NAM'}
          />
          <span className={`tone3000-runtime tone3000-runtime-${tone3000State?.phase ?? 'loading'}`}>
            {tone3000State?.phase === 'ready'
              ? '已就绪'
              : tone3000State?.phase === 'error'
                ? tone3000State.message ?? '模型不可用，当前直通'
                : '加载中，当前直通…'}
          </span>
          {item.modelId && (
            <span className="tone3000-model-variant-summary" title={`model #${item.modelId}`}>
              {tone3000State?.modelVariant?.name || `采样 #${item.modelId}`}
              {tone3000State?.modelVariant
                ? ` · ${tone3000State.modelVariant.architecture === 'custom' ? 'Custom' : `A${tone3000State.modelVariant.architecture}`} · ${tone3000State.modelVariant.size}`
                : ''}
            </span>
          )}
          {tone3000State?.phase === 'error' && (
            <button className="tone3000-pedal-repair" onClick={() => onRepairTone3000?.(item.uid)}>
              {tone3000State.reason === 'not-authenticated'
                ? '登录并重试'
                : tone3000State.reason === 'tone-unavailable'
                  ? '选择替代模型…'
                  : '重试'}
            </button>
          )}
          {item.modelRef && (
            <button
              className="tone3000-pedal-replace"
              disabled={Boolean(tone3000ModelListProgress)}
              onClick={() => onSwitchTone3000ModelVariant?.(item.uid)}
            >
              {tone3000ModelListProgress
                ? tone3000ModelListProgressText(tone3000ModelListProgress)
                : '切换采样…'}
            </button>
          )}
          <button className="tone3000-pedal-replace" onClick={() => onReplaceTone3000?.(item.uid)}>
            更换 Tone…
          </button>
        </div>
      )}

      {TREADLE_EFFECT_IDS.has(def.id) && (
        <span data-midi-target={`pedal-treadle:${index}`}>
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
        </span>
      )}

      <button
        className={`footswitch ${item.enabled ? 'fs-on' : ''}`}
        title={item.enabled ? '踩下以关闭' : '踩下以开启'}
        data-midi-target={`pedal-toggle:${index}`}
        onClick={() => onToggle(item.uid)}
      >
        <span className="footswitch-cap" />
      </button>
    </div>
  );
}
