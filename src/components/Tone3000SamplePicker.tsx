import { useEffect, useMemo, useState } from 'react';
import type {
  Tone3000ModelArchitecture,
  Tone3000ModelInfo,
} from '../tone3000/client';
import {
  tone3000Rig,
} from '../tone3000/useTone3000Rig';
import type { Tone3000SampleSelection } from '../tone3000/rigIntegration';

interface Tone3000SamplePickerProps {
  selection: Tone3000SampleSelection;
  onBack?: () => void;
  onClose(): void;
  onApplied?(): void;
}

const ARCHITECTURES: Tone3000ModelArchitecture[] = ['2', '1', 'custom'];

function sampleLabel(sample: Tone3000ModelInfo): string {
  return sample.name || `采样 #${sample.id}`;
}

/** 只负责展示并确认已经由集成层完成分页、校验和排序的采样列表。 */
export function Tone3000SamplePicker({
  selection,
  onBack,
  onClose,
  onApplied,
}: Tone3000SamplePickerProps) {
  const initialModelId =
    selection.preferredModelId &&
    selection.samples.some((sample) => sample.id === selection.preferredModelId)
      ? selection.preferredModelId
      : selection.currentModelId &&
          selection.samples.some((sample) => sample.id === selection.currentModelId)
        ? selection.currentModelId
        : selection.samples[0]?.id ?? '';
  const [selectedModelId, setSelectedModelId] = useState(initialModelId);
  const [query, setQuery] = useState('');
  const [architecture, setArchitecture] = useState<'all' | Tone3000ModelArchitecture>('all');
  const [size, setSize] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedModelId(initialModelId);
    setQuery('');
    setArchitecture('all');
    setSize('all');
    setError(null);
  }, [initialModelId, selection.toneId]);

  const sizes = useMemo(
    () => [...new Set(selection.samples.map((sample) => sample.size))].sort(),
    [selection.samples],
  );
  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return selection.samples.filter((sample) => {
      if (architecture !== 'all' && sample.architecture !== architecture) return false;
      if (size !== 'all' && sample.size !== size) return false;
      return (
        !normalizedQuery ||
        sampleLabel(sample).toLocaleLowerCase().includes(normalizedQuery) ||
        sample.id.includes(normalizedQuery)
      );
    });
  }, [architecture, query, selection.samples, size]);

  const confirm = async () => {
    if (!selectedModelId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await tone3000Rig.confirmSelection(selectedModelId);
      if (!result.ok) throw new Error(result.message);
      onApplied?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    tone3000Rig.cancelSelection();
    onClose();
  };

  return (
    <>
      <div className="tone3000-sample-heading">
        {onBack && (
          <button
            className="tone3000-logout"
            disabled={busy}
            onClick={() => {
              tone3000Rig.cancelSelection();
              onBack();
            }}
          >
            ← 返回选择 Tone
          </button>
        )}
        <h3>选择 TONE3000 采样</h3>
        <span className="tone3000-byline">Tone #{selection.toneId}</span>
      </div>

      <div className="tone3000-sample-filters">
        <input
          className="tone3000-paste-input"
          type="search"
          placeholder="搜索采样名称或 model id…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          value={architecture}
          onChange={(event) =>
            setArchitecture(event.target.value as 'all' | Tone3000ModelArchitecture)
          }
          aria-label="按架构筛选采样"
        >
          <option value="all">全部架构</option>
          <option value="2">A2</option>
          <option value="1">A1</option>
          <option value="custom">Custom</option>
        </select>
        <select
          value={size}
          onChange={(event) => setSize(event.target.value)}
          aria-label="按 size 筛选采样"
        >
          <option value="all">全部 size</option>
          {sizes.map((candidate) => (
            <option key={candidate} value={candidate}>{candidate}</option>
          ))}
        </select>
      </div>

      {selection.currentModelUnavailable && selection.currentModelId && (
        <div className="tone3000-sample-unavailable" aria-disabled="true">
          <strong>当前采样 #{selection.currentModelId}</strong>
          <span>当前账号无法访问；请选择替代采样</span>
        </div>
      )}

      <div className="tone3000-sample-groups">
        {ARCHITECTURES.map((candidateArchitecture) => {
          const group = filtered.filter(
            (sample) => sample.architecture === candidateArchitecture,
          );
          if (group.length === 0) return null;
          return (
            <section key={candidateArchitecture} className="tone3000-sample-group">
              <h4>{candidateArchitecture === 'custom' ? 'Custom' : `A${candidateArchitecture}`}</h4>
              {group.map((sample) => (
                <label
                  key={sample.id}
                  className={`tone3000-sample-item ${selectedModelId === sample.id ? 'active' : ''}`}
                >
                  <input
                    type="radio"
                    name="tone3000-sample"
                    value={sample.id}
                    checked={selectedModelId === sample.id}
                    onChange={() => setSelectedModelId(sample.id)}
                  />
                  <span className="tone3000-sample-copy">
                    <strong>{sampleLabel(sample)}</strong>
                    <span>
                      {sample.architecture === 'custom' ? 'Custom' : `A${sample.architecture}`}
                      {' · '}{sample.size}{' · '}model #{sample.id}
                    </span>
                  </span>
                  {sample.id === selection.currentModelId && (
                    <span className="tone3000-sample-current">当前</span>
                  )}
                </label>
              ))}
            </section>
          );
        })}
        {filtered.length === 0 && (
          <div className="tone3000-notice">没有符合筛选条件的采样</div>
        )}
      </div>

      {error && <div className="tone3000-notice" role="alert">{error}</div>}
      <div className="tone3000-sample-actions">
        <button className="tone3000-logout" disabled={busy} onClick={cancel}>取消</button>
        <button
          className="nam-load-btn"
          disabled={busy || !selectedModelId}
          onClick={() => void confirm()}
        >
          {busy ? '正在下载并切换…' : '使用这个采样'}
        </button>
      </div>
    </>
  );
}
