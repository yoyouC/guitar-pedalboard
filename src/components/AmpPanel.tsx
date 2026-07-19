import { AMP_REGISTRY } from '../audio/amps';
import type { EffectDefinition } from '../audio/effects/types';
import { Knob } from './Knob';
import { MiniMeter } from './MiniMeter';

interface NamModelOption {
  id: string;
  name: string;
}

interface AmpPanelProps {
  ampId: string;
  enabled: boolean;
  values: Record<string, number>;
  analyser: AnalyserNode | null;
  showMeters: boolean;
  onSelect: (ampId: string) => void;
  onToggle: () => void;
  onParam: (key: string, value: number) => void;
  /** NAM 类箱头(nam / nam-wasm)专用:模型清单、当前模型源 id、自定义模型名、模型切换与本地文件加载回调 */
  namModels?: NamModelOption[];
  namSourceId?: string;
  namCustomName?: string | null;
  onNamModelSelect?: (id: string) => void;
  onNamModelFile?: (file: File) => void;
}

function getDef(ampId: string): EffectDefinition {
  return AMP_REGISTRY.find((d) => d.id === ampId) ?? AMP_REGISTRY[0];
}

/** 箱头模拟面板:型号选择 + 拟物箱头(tolex 外壳 + 旋钮排 + 电源开关) */
export function AmpPanel({ ampId, enabled, values, analyser, showMeters, onSelect, onToggle, onParam, namModels, namSourceId, namCustomName, onNamModelSelect, onNamModelFile }: AmpPanelProps) {
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

      {namModels && onNamModelFile && onNamModelSelect && (
        <div className="nam-model-row">
          <select
            className="nam-model-select"
            value={namSourceId}
            onChange={(e) => onNamModelSelect(e.target.value)}
          >
            {namModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
            {namSourceId === 'custom' && (
              <option value="custom">{namCustomName ?? '自定义模型'}(自定义)</option>
            )}
          </select>
          <label className="nam-load-btn">
            加载 .nam…
            <input
              type="file"
              accept=".nam,application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onNamModelFile(f);
                e.target.value = '';
              }}
            />
          </label>
        </div>
      )}

      <div className={`amp-head amp-${ampId} ${enabled ? 'amp-on' : 'amp-off'}`}>
        <div className="amp-top">
          <span className="amp-brand">{def.name}</span>
          <span className="amp-top-right">
            {enabled && showMeters && <MiniMeter analyser={analyser} />}
            <span className={`amp-jewel ${enabled ? 'jewel-on' : ''}`} />
          </span>
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

        <div className="amp-grill" />
      </div>
    </div>
  );
}
