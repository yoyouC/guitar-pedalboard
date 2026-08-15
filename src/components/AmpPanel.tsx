import { useSyncExternalStore } from 'react';
import { AMP_CATEGORIES } from '../audio/ampCategories';
import { getAmpDef } from '../audio/amps';
import { NAM_SWEEP_PACKS, loadNamWasmModelFromFile } from '../audio/namWasm';
import { audioEngine } from '../audio/AudioEngine';
import { getAmpLoadState, subscribeAmpLoad } from '../audio/loadProgress';
import { rigStore, useRig } from '../state/useRig';
import { Knob } from './Knob';
import { MiniMeter } from './MiniMeter';

interface AmpPanelProps {
  showMeters: boolean;
  engineReady: boolean;
}

/** 箱头模拟面板:4 个分类 tab(Fender Clean / Vox / Marshall Crunch / High Gain)+ 类内型号选择 */
export function AmpPanel({ showMeters, engineReady }: AmpPanelProps) {
  const loadState = useSyncExternalStore(subscribeAmpLoad, getAmpLoadState);
  const categoryId = useRig((s) => s.ampCategoryId);
  const modelKeys = useRig((s) => s.ampModelKeys);
  const enabled = useRig((s) => s.ampEnabled);
  const values = useRig((s) => s.ampValues);
  const namCustomName = useRig((s) => s.namCustomName);
  // 图谱重建后重读引擎侧电平表节点引用
  useRig((s) => s.graphVersion);
  const modelKey = modelKeys[categoryId];
  const category = AMP_CATEGORIES.find((c) => c.id === categoryId) ?? AMP_CATEGORIES[0];
  const model = category.models.find((m) => m.key === modelKey) ?? category.models[0];
  const def = getAmpDef(
    model.kind === 'builtin' ? model.ref : 'nam-wasm',
  );
  const analyser = engineReady ? audioEngine.ampAnalyser : null;

  // NAM:加载本地 .nam 模型(WASM Core 支持全架构),成功后置为当前类的型号
  const handleNamModelFile = async (file: File) => {
    try {
      const model = await loadNamWasmModelFromFile(file);
      rigStore.setNamCustomModel(model.displayName);
    } catch (e) {
      alert(`加载 .nam 模型失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const isNam = model.kind !== 'builtin';
  // 扫档包:由 GAIN 旋钮值推导当前档位标签(g5.5 等)
  const sweepPack = model.kind === 'nam-wasm-pack' ? NAM_SWEEP_PACKS[model.ref] : null;
  const sweepStage = sweepPack
    ? sweepPack.stages[
        Math.min(
          sweepPack.stages.length - 1,
          Math.floor(((values.gain ?? 50) / 100) * sweepPack.stages.length),
        )
      ].gain
    : null;

  return (
    <div className="amp-section">
      <div className="amp-selector">
        <span className="section-title">箱头模拟</span>
        {AMP_CATEGORIES.map((c) => (
          <button
            key={c.id}
            className={`amp-tab ${c.id === categoryId ? 'active' : ''}`}
            onClick={() => rigStore.setAmpModel(c.id, modelKeys[c.id] ?? c.models[0].key)}
          >
            {c.name}
          </button>
        ))}
      </div>

      <div className="nam-model-row">
        <select
          className="nam-model-select"
          value={modelKey}
          onChange={(e) => rigStore.setAmpModel(categoryId, e.target.value)}
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
        {sweepStage !== null && <span className="nam-stage-label">档位 g{sweepStage}</span>}
        {model.kind === 'nam-wasm' && (
          <label className="nam-load-btn">
            加载 .nam…
            <input
              type="file"
              accept=".nam,application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleNamModelFile(f);
                e.target.value = '';
              }}
            />
          </label>
        )}
      </div>

      {loadState.phase === 'loading' && (
        <div
          className="amp-loadbar"
          role="progressbar"
          aria-valuenow={loadState.done}
          aria-valuemax={loadState.total}
        >
          <div
            className="amp-loadbar-fill"
            style={{ width: `${loadState.total ? (loadState.done / loadState.total) * 100 : 0 }%` }}
          />
          <span className="amp-loadbar-label">
            {loadState.label || '加载中…'} {loadState.done}/{loadState.total}
          </span>
        </div>
      )}

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
              <span key={p.key} data-midi-target={`amp-param:${p.key}`}>
                <Knob
                  value={values[p.key] ?? p.defaultValue}
                  min={p.min}
                  max={p.max}
                  step={p.step}
                  defaultValue={p.defaultValue}
                  label={p.label}
                  unit={p.unit}
                  disabled={!enabled}
                  onChange={(v) => rigStore.setAmpParam(p.key, v)}
                />
              </span>
            ))}
          </div>

          <button
            className={`amp-power ${enabled ? 'power-on' : ''}`}
            title={enabled ? '关闭箱头(直通)' : '开启箱头'}
            onClick={() => rigStore.setAmpEnabled(!enabled)}
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
