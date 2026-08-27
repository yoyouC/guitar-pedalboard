import { useState, useSyncExternalStore } from 'react';
import {
  getTone3000Authenticated,
  subscribeTone3000Auth,
  type Tone3000Selection,
} from '../tone3000/instance';
import {
  tone3000GearForIntent,
  type Tone3000PendingIntent,
} from '../tone3000/callback';
import { tone3000Rig, useTone3000Rig } from '../tone3000/useTone3000Rig';
import type { Tone3000TargetIntent } from '../tone3000/rigIntegration';
import type { ToneInfo } from '../tone3000/client';
import { putCachedToneInfo } from '../tone3000/toneInfoCache';
import { Tone3000Discover } from './Tone3000Discover';
import { Tone3000Account } from './Tone3000Display';
import { Tone3000SamplePicker } from './Tone3000SamplePicker';

interface Tone3000SelectorProps {
  intent: Tone3000TargetIntent;
  currentToneId?: string | null;
  /** 失效修复时走 load_tone；普通“换模型”仍走完整 Select。 */
  loadToneId?: string;
  onClose(): void;
}

/** Amp/Pedal 共用的托管选择、粘贴和 Trending 入口。 */
export function Tone3000Selector({
  intent,
  currentToneId = null,
  loadToneId,
  onClose,
}: Tone3000SelectorProps) {
  const gear = tone3000GearForIntent(intent);
  const authed = useSyncExternalStore(subscribeTone3000Auth, getTone3000Authenticated);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selection = useTone3000Rig((state) => state.selection);

  const pendingIntent = (architecture: '2' | 'legacy' = '2'): Tone3000PendingIntent =>
    intent.kind === 'replace-pedal'
      ? { ...intent, architecture }
      : { ...intent, architecture };

  const close = () => {
    tone3000Rig.cancelSelection();
    onClose();
  };

  const browse = async (architecture: '2' | 'legacy') => {
    setBusy(true);
    setError(null);
    try {
      const result = await tone3000Rig.selectHosted(intent, architecture, loadToneId);
      if (result && !result.ok) throw new Error(result.message);
      if (result?.ok && result.status === 'applied') onClose();
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
      if (info) putCachedToneInfo(info, window.localStorage);
      const result = await tone3000Rig.prepareSelection(
        selection.toneId,
        selection.modelId,
        pendingIntent(),
      );
      if (!result.ok) throw new Error(result.message);
      if (result.status === 'applied') onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tone3000-modal-backdrop" role="presentation" onMouseDown={close}>
      <section
        className="tone3000-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`选择 TONE3000 ${gear}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="tone3000-modal-close" onClick={close} aria-label="关闭">×</button>
        {selection && !selection.resumed ? (
          <Tone3000SamplePicker
            selection={selection}
            onBack={() => {}}
            onClose={onClose}
            onApplied={onClose}
          />
        ) : (
          <>
            <h3>TONE3000 {gear === 'pedal' ? 'NAM 单块' : 'NAM 箱头'}</h3>
            <Tone3000Account />
            <div className="tone3000-browser-actions">
              <button className="nam-load-btn" disabled={busy} onClick={() => void browse('2')}>
                {busy ? '正在打开…' : '浏览 A2 Tone…'}
              </button>
              <button className="tone3000-logout" disabled={busy} onClick={() => void browse('legacy')}>
                浏览 A1 / Custom Tone…
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
          </>
        )}
      </section>
    </div>
  );
}
