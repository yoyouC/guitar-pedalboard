import { useState, useSyncExternalStore } from 'react';
import { rigStore } from '../state/useRig';
import { rigToShareState } from '../state/rigStore';
import { encodeShareState } from '../state/share';
import {
  browseTone3000,
  getTone3000Authenticated,
  subscribeTone3000Auth,
  type Tone3000Selection,
  replaceTone3000,
} from '../tone3000/instance';
import type { Tone3000PendingIntent } from '../tone3000/callback';
import type { ToneInfo } from '../tone3000/client';
import { Tone3000Discover } from './Tone3000Discover';
import { Tone3000Account } from './Tone3000Display';

interface Tone3000SelectorProps {
  intent: Tone3000PendingIntent;
  gear: 'amp' | 'pedal';
  currentToneId?: string | null;
  /** 失效修复时走 load_tone；普通“换模型”仍走完整 Select。 */
  loadToneId?: string;
  onSelect(selection: Tone3000Selection, info?: ToneInfo): void | Promise<void>;
  onClose(): void;
}

/** Amp/Pedal 共用的托管选择、粘贴和 Trending 入口。 */
export function Tone3000Selector({
  intent,
  gear,
  currentToneId = null,
  loadToneId,
  onSelect,
  onClose,
}: Tone3000SelectorProps) {
  const authed = useSyncExternalStore(subscribeTone3000Auth, getTone3000Authenticated);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const encodedRig = () => encodeShareState(rigToShareState(rigStore.getState()));

  const browse = async (architecture: '2' | 'legacy') => {
    setBusy(true);
    setError(null);
    try {
      const options = {
        intent: { ...intent, architecture },
        gears: gear,
        architecture,
      } as const;
      const selection = loadToneId
        ? await replaceTone3000(loadToneId, encodedRig, options)
        : await browseTone3000(encodedRig, options);
      if (selection) await onSelect(selection);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const select = async (selection: Tone3000Selection, info?: ToneInfo) => {
    setBusy(true);
    setError(null);
    try {
      await onSelect(selection, info);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tone3000-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="tone3000-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`选择 TONE3000 ${gear}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="tone3000-modal-close" onClick={onClose} aria-label="关闭">×</button>
        <h3>TONE3000 {gear === 'pedal' ? 'NAM 单块' : 'NAM 箱头'}</h3>
        <Tone3000Account />
        <div className="tone3000-browser-actions">
          <button className="nam-load-btn" disabled={busy} onClick={() => void browse('2')}>
            {busy ? '正在打开…' : '浏览 A2 模型…'}
          </button>
          <button className="tone3000-logout" disabled={busy} onClick={() => void browse('legacy')}>
            浏览 A1 / Custom…
          </button>
        </div>
        {error && <div className="tone3000-notice" role="alert">{error}</div>}
        {authed && (
          <Tone3000Discover
            currentToneId={currentToneId}
            gear={gear}
            showLatest={gear !== 'pedal'}
            onLoad={(toneId, info) => void select({ toneId }, info)}
          />
        )}
        <div className="tone3000-powered">
          Powered by <a href="https://www.tone3000.com" target="_blank" rel="noreferrer">TONE3000</a>
        </div>
      </section>
    </div>
  );
}
