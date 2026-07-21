import { AMP_CATEGORIES } from '../audio/ampCategories';
import { getAmpDef } from '../audio/amps';
import { Knob } from './Knob';
import { MiniMeter } from './MiniMeter';

interface AmpPanelProps {
  categoryId: string;
  modelKey: string;
  enabled: boolean;
  values: Record<string, number>;
  analyser: AnalyserNode | null;
  showMeters: boolean;
  onCategorySelect: (categoryId: string) => void;
  onModelSelect: (modelKey: string) => void;
  onToggle: () => void;
  onParam: (key: string, value: number) => void;
  /** NAM 型号(nam-lstm / nam-wasm)的自定义模型名与本地 .nam 加载回调 */
  namCustomName?: string | null;
  onNamModelFile?: (file: File) => void;
}

/** 箱头模拟面板:4 个分类 tab(Fender Clean / Vox / Marshall Crunch / High Gain)+ 类内型号选择 */
export function AmpPanel({ categoryId, modelKey, enabled, values, analyser, showMeters, onCategorySelect, onModelSelect, onToggle, onParam, namCustomName, onNamModelFile }: AmpPanelProps) {
  const category = AMP_CATEGORIES.find((c) => c.id === categoryId) ?? AMP_CATEGORIES[0];
  const model = category.models.find((m) => m.key === modelKey) ?? category.models[0];
  const def = getAmpDef(model.kind === 'nam-lstm' ? 'nam' : model.kind === 'nam-wasm' ? 'nam-wasm' : model.ref);
  const isNam = model.kind !== 'builtin';

  return (
    <div className="amp-section">
      <div className="amp-selector">
        <span className="section-title">箱头模拟</span>
        {AMP_CATEGORIES.map((c) => (
          <button
            key={c.id}
            className={`amp-tab ${c.id === categoryId ? 'active' : ''}`}
            onClick={() => onCategorySelect(c.id)}
          >
            {c.name}
          </button>
        ))}
      </div>

      <div className="nam-model-row">
        <select
          className="nam-model-select"
          value={modelKey}
          onChange={(e) => onModelSelect(e.target.value)}
        >
          {category.models.map((m) => (
            <option key={m.key} value={m.key}>
              {m.name}
            </option>
          ))}
          {isNam && modelKey.endsWith(':custom') && (
            <option value={modelKey}>{namCustomName ?? '自定义模型'}(自定义)</option>
          )}
        </select>
        {isNam && onNamModelFile && (
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
        )}
      </div>

      <div className={`amp-head amp-${category.id} ${enabled ? 'amp-on' : 'amp-off'}`}>
        <div className="amp-top">
          <span className="amp-brand">{model.name}</span>
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
