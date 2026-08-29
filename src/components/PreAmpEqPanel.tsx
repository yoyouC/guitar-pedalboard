import { useEffect, useState } from 'react';
import {
  PRE_AMP_EQ_BANDS,
  PRE_AMP_EQ_MAX_DB,
  PRE_AMP_EQ_MIN_DB,
  PRE_AMP_EQ_STEP_DB,
} from '../audio/preAmpEq';
import { rigStore, useRig } from '../state/useRig';

const COLLAPSED_KEY = 'guitar-pedalboard-preamp-eq-collapsed-v1';

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

/** 固定在前置 Pedal 与 Amp 之间的十段箱头前均衡。 */
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
          <span className="preamp-eq-subtitle">PRE-AMP EQ · GRAPHIC EQUALIZER</span>
          <span className={`preamp-eq-status ${eq.enabled ? 'is-on' : ''}`}>
            {eq.enabled ? 'ACTIVE' : 'BYPASSED'}
          </span>
          <span className="preamp-eq-route" aria-hidden="true">→ AMP</span>
        </div>
        <div className="preamp-eq-actions">
          <button type="button" className="preamp-eq-reset" onClick={() => rigStore.resetPreAmpEq()}>
            Reset 0 dB
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
          <div className="preamp-eq-controls" aria-label="箱头前十段均衡">
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
