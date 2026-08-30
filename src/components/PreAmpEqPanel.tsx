import { useEffect, useState } from 'react';
import {
  PRE_AMP_EQ_BANDS,
  PRE_AMP_EQ_HIGH_CUT_MAX_HZ,
  PRE_AMP_EQ_HIGH_CUT_MIN_HZ,
  PRE_AMP_EQ_LOW_CUT_MAX_HZ,
  PRE_AMP_EQ_LOW_CUT_MIN_HZ,
  PRE_AMP_EQ_MAX_DB,
  PRE_AMP_EQ_MIN_DB,
  PRE_AMP_EQ_STEP_DB,
  type PreAmpEqCutKind,
} from '../audio/preAmpEq';
import { rigStore, useRig } from '../state/useRig';

const COLLAPSED_KEY = 'guitar-pedalboard-preamp-eq-collapsed-v1';
const CUT_SLIDER_STEPS = 1000;

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

function formatDb(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
}

function formatFrequency(frequencyHz: number): string {
  return frequencyHz >= 1000
    ? `${(frequencyHz / 1000).toFixed(1)} kHz`
    : `${frequencyHz} Hz`;
}

function frequencyToSlider(frequencyHz: number, min: number, max: number): number {
  const ratio = Math.log(frequencyHz / min) / Math.log(max / min);
  return Math.round(Math.max(0, Math.min(1, ratio)) * CUT_SLIDER_STEPS);
}

function sliderToFrequency(value: number, min: number, max: number): number {
  const ratio = Math.max(0, Math.min(CUT_SLIDER_STEPS, value)) / CUT_SLIDER_STEPS;
  return Math.round(min * (max / min) ** ratio);
}

interface CutControlProps {
  kind: PreAmpEqCutKind;
  enabled: boolean;
  frequencyHz: number;
  min: number;
  max: number;
  label: string;
  filterLabel: string;
}

function CutControl({
  kind,
  enabled,
  frequencyHz,
  min,
  max,
  label,
  filterLabel,
}: CutControlProps) {
  const formatted = formatFrequency(frequencyHz);
  const midpoint = Math.round(Math.sqrt(min * max));
  return (
    <div className={`preamp-eq-band preamp-eq-cut ${enabled ? 'is-on' : 'is-off'}`}>
      <output className="preamp-eq-value">{formatted}</output>
      <span className="preamp-eq-scale" aria-hidden="true">
        <span>{formatFrequency(max)}</span>
        <span>{formatFrequency(midpoint)}</span>
        <span>{formatFrequency(min)}</span>
      </span>
      <label
        className="preamp-eq-cut-range"
        data-midi-target={`preamp-eq-cut-frequency:${kind}`}
      >
        <input
          type="range"
          min={0}
          max={CUT_SLIDER_STEPS}
          step={1}
          value={frequencyToSlider(frequencyHz, min, max)}
          aria-label={`箱头前均衡${label}截止频率`}
          aria-valuetext={formatted}
          onChange={(event) => rigStore.setPreAmpEqCutFrequency(
            kind,
            sliderToFrequency(Number(event.currentTarget.value), min, max),
          )}
        />
      </label>
      <span className="preamp-eq-frequency">{label}</span>
      <span className="preamp-eq-unit">{filterLabel}</span>
      <span
        className="preamp-eq-cut-toggle-target"
        data-midi-target={`preamp-eq-cut-toggle:${kind}`}
      >
        <button
          type="button"
          className={`preamp-eq-cut-toggle ${enabled ? 'is-on' : ''}`}
          aria-label={`${label} ${enabled ? '已开启' : '已关闭'}`}
          aria-pressed={enabled}
          onClick={() => rigStore.setPreAmpEqCutEnabled(kind, !enabled)}
        >
          {enabled ? 'ON' : 'OFF'}
        </button>
      </span>
    </div>
  );
}

/** 固定在前置 Pedal 与 Amp 之间的十段箱头前均衡及高低切。 */
export function PreAmpEqPanel() {
  const eq = useRig((state) => state.preAmpEq);
  const [collapsed, setCollapsed] = useState(loadCollapsed);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, String(collapsed));
    } catch {
      /* localStorage 不可用时保留本次会话状态 */
    }
  }, [collapsed]);

  return (
    <section className={`preamp-eq-panel ${eq.enabled ? 'eq-enabled' : 'eq-bypassed'}`}>
      <header className="preamp-eq-header">
        <div className="preamp-eq-heading">
          <span className="preamp-eq-route" aria-hidden="true">PEDALS →</span>
          <span className="preamp-eq-title">箱头前 EQ</span>
          <span className="preamp-eq-subtitle">PRE-AMP EQ · GRAPHIC EQ + CUTS</span>
          <span className={`preamp-eq-status ${eq.enabled ? 'is-on' : ''}`}>
            {eq.enabled ? 'ACTIVE' : 'BYPASSED'}
          </span>
          <span className="preamp-eq-route" aria-hidden="true">→ AMP</span>
        </div>
        <div className="preamp-eq-actions">
          <button type="button" className="preamp-eq-reset" onClick={() => rigStore.resetPreAmpEq()}>
            Reset EQ
          </button>
          <span data-midi-target="preamp-eq-toggle">
            <button
              type="button"
              className={`preamp-eq-bypass ${eq.enabled ? 'is-on' : ''}`}
              aria-pressed={eq.enabled}
              onClick={() => rigStore.setPreAmpEqEnabled(!eq.enabled)}
            >
              {eq.enabled ? 'EQ ON' : 'BYPASS'}
            </button>
          </span>
          <button
            type="button"
            className="preamp-eq-collapse"
            aria-controls="preamp-eq-controls"
            aria-expanded={!collapsed}
            aria-label={collapsed ? '展开箱头前均衡' : '折叠箱头前均衡'}
            onClick={() => setCollapsed((value) => !value)}
          >
            <span aria-hidden="true">{collapsed ? '▾' : '▴'}</span>
            {collapsed ? '展开' : '折叠'}
          </button>
        </div>
      </header>

      {!collapsed && (
        <div id="preamp-eq-controls" className="preamp-eq-scroll">
          <div className="preamp-eq-controls" aria-label="箱头前均衡">
            <CutControl
              kind="lowCut"
              enabled={eq.lowCut.enabled}
              frequencyHz={eq.lowCut.frequencyHz}
              min={PRE_AMP_EQ_LOW_CUT_MIN_HZ}
              max={PRE_AMP_EQ_LOW_CUT_MAX_HZ}
              label="低切 LOW CUT"
              filterLabel="HPF"
            />
            <div className="preamp-eq-graphic-group">
              {PRE_AMP_EQ_BANDS.map((band) => {
                const value = eq.bands[band.key];
                return (
                  <label key={band.key} className="preamp-eq-band" data-midi-target={`preamp-eq-band:${band.key}`}>
                    <output className="preamp-eq-value">{formatDb(value)}</output>
                    <span className="preamp-eq-scale" aria-hidden="true">
                      <span>+12</span><span>0</span><span>−12</span>
                    </span>
                    <input
                      type="range"
                      min={PRE_AMP_EQ_MIN_DB}
                      max={PRE_AMP_EQ_MAX_DB}
                      step={PRE_AMP_EQ_STEP_DB}
                      value={value}
                      aria-label={`${band.label} Hz 增益`}
                      aria-valuetext={formatDb(value)}
                      onChange={(event) => rigStore.setPreAmpEqBand(band.key, Number(event.currentTarget.value))}
                    />
                    <span className="preamp-eq-frequency">{band.label}</span>
                    <span className="preamp-eq-unit">Hz</span>
                  </label>
                );
              })}
            </div>
            <CutControl
              kind="highCut"
              enabled={eq.highCut.enabled}
              frequencyHz={eq.highCut.frequencyHz}
              min={PRE_AMP_EQ_HIGH_CUT_MIN_HZ}
              max={PRE_AMP_EQ_HIGH_CUT_MAX_HZ}
              label="高切 HIGH CUT"
              filterLabel="LPF"
            />
            <label className="preamp-eq-band preamp-eq-level" data-midi-target="preamp-eq-level">
              <output className="preamp-eq-value">{formatDb(eq.levelDb)}</output>
              <span className="preamp-eq-scale" aria-hidden="true">
                <span>+12</span><span>0</span><span>−12</span>
              </span>
              <input
                type="range"
                min={PRE_AMP_EQ_MIN_DB}
                max={PRE_AMP_EQ_MAX_DB}
                step={PRE_AMP_EQ_STEP_DB}
                value={eq.levelDb}
                aria-label="箱头前均衡输出 Level"
                aria-valuetext={formatDb(eq.levelDb)}
                onChange={(event) => rigStore.setPreAmpEqLevel(Number(event.currentTarget.value))}
              />
              <span className="preamp-eq-frequency">LEVEL</span>
              <span className="preamp-eq-unit">dB</span>
            </label>
          </div>
        </div>
      )}
    </section>
  );
}
