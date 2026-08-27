import { useState } from 'react';
import type { Tone3000TargetIntent } from '../tone3000/rigIntegration';
import { tone3000Rig, useTone3000Rig } from '../tone3000/useTone3000Rig';
import { Tone3000ModelVariantPicker } from './Tone3000ModelVariantPicker';

/** popup 被阻挡后的整页回跳宿主：React 挂载后继续未完成的采样确认。 */
export function Tone3000RedirectSelection() {
  const selection = useTone3000Rig((state) => state.selection);
  const [error, setError] = useState<string | null>(null);
  if (!selection?.resumed) return null;

  const targetIntent: Tone3000TargetIntent | null =
    selection.intent.kind === 'amp'
      ? { kind: 'amp' }
      : selection.intent.kind === 'add-pedal'
        ? { kind: 'add-pedal' }
        : selection.intent.kind === 'replace-pedal'
          ? { kind: 'replace-pedal', uid: selection.intent.uid }
          : null;

  const chooseAnotherTone = async () => {
    if (!targetIntent || !('architecture' in selection.intent)) return;
    setError(null);
    const result = await tone3000Rig.selectHosted(
      targetIntent,
      selection.intent.architecture,
      undefined,
      true,
    );
    if (result && !result.ok) setError(result.message);
  };

  return (
    <div
      className="tone3000-modal-backdrop"
      role="presentation"
      onMouseDown={() => tone3000Rig.cancelSelection()}
    >
      <section
        className="tone3000-modal"
        role="dialog"
        aria-modal="true"
        aria-label="继续选择 TONE3000 采样"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          className="tone3000-modal-close"
          onClick={() => tone3000Rig.cancelSelection()}
          aria-label="关闭"
        >
          ×
        </button>
        <Tone3000ModelVariantPicker
          selection={selection}
          onBack={targetIntent ? () => void chooseAnotherTone() : undefined}
          onClose={() => {}}
        />
        {error && <div className="tone3000-notice" role="alert">{error}</div>}
      </section>
    </div>
  );
}
