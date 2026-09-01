import { useState, useSyncExternalStore } from 'react';
import { collectionQueue } from '../marketplace/collectionQueueSession';
import { toneSession, useToneSession } from '../marketplace/toneSession';
import { rigStore } from '../state/useRig';

export function ToneSessionBar() {
  const session = useToneSession();
  const queueState = useSyncExternalStore(collectionQueue.subscribe, collectionQueue.getState);
  const queue = queueState.queue;
  const [message, setMessage] = useState('');
  const [showQueue, setShowQueue] = useState(false);
  const [pendingPosition, setPendingPosition] = useState<number | null>(null);
  const [presetName, setPresetName] = useState('');
  const [busy, setBusy] = useState(false);
  if (!session.tone) return null;

  const switchTo = async (position: number) => {
    setBusy(true);
    setMessage('');
    const result = await collectionQueue.switchTo(position);
    setBusy(false);
    setPendingPosition(null);
    if (!result.ok) setMessage(result.message ?? 'Could not switch to this fixed revision.');
  };
  const requestSwitch = (position: number | null) => {
    if (position === null || busy) return;
    if (session.modified) {
      setPresetName(`${session.tone?.title ?? 'Tone'} edit`);
      setPendingPosition(position);
    } else void switchTo(position);
  };
  const restore = async () => {
    const result = await toneSession.backToOriginal();
    if (result.ok) collectionQueue.clear();
    else setMessage(result.message ?? 'Could not restore My Original Rig.');
  };
  const exit = () => {
    collectionQueue.clear();
    toneSession.exit();
  };
  const saveAndContinue = () => {
    const name = presetName.trim();
    if (!name || pendingPosition === null) return;
    rigStore.savePreset(name);
    void switchTo(pendingPosition);
  };

  return (
    <aside className="tone-session-bar" aria-label="Tone Market session">
      <div>
        <strong>{session.tone.title}</strong>
        <span>@{session.tone.creator.handle} · fixed revision {session.tone.revisionId}</span>
        {queue && <span>{queue.collectionTitle} · position {queue.currentPosition + 1} / {queue.items.length}</span>}
      </div>
      {session.modified && <span className="tone-session-bar__modified">Modified</span>}
      {queue && <>
        <button type="button" disabled={busy || collectionQueue.previousPosition() === null} onClick={() => requestSwitch(collectionQueue.previousPosition())}>Previous</button>
        <button type="button" disabled={busy || collectionQueue.nextPosition() === null} onClick={() => requestSwitch(collectionQueue.nextPosition())}>Next</button>
        <button type="button" onClick={() => setShowQueue((value) => !value)}>{showQueue ? 'Hide Queue' : 'View Queue'}</button>
      </>}
      <button type="button" onClick={() => void restore()}>Back to My Rig</button>
      <button type="button" onClick={exit}>Exit Session</button>
      {message && <span role="alert">{message}</span>}

      {queue && showQueue && <ol className="tone-session-bar__queue">{queue.items.map((item) => <li key={`${item.position}-${item.presetId}-${item.revisionId}`} className={item.position === queue.currentPosition ? 'current' : ''}><span>{item.position + 1}</span>{item.availability === 'available' ? <button type="button" disabled={busy || item.position === queue.currentPosition} onClick={() => requestSwitch(item.position)}>{item.title}<small>@{item.creator.handle} · revision {item.revisionId}</small></button> : <div><strong>Skipped Tone</strong><small>{item.skipReason ?? `@${item.creator.handle} · fixed placeholder unavailable`}</small></div>}</li>)}</ol>}

      {pendingPosition !== null && <div className="tone-session-bar__decision" role="dialog" aria-modal="true" aria-label="Current tone has unsaved changes">
        <strong>Current tone has unsaved changes</strong><p>Switching discards these edits. Save them as a Local Preset, discard and continue, or cancel.</p>
        <label>Local Preset name<input value={presetName} onChange={(event) => setPresetName(event.target.value)} /></label>
        <div><button type="button" disabled={!presetName.trim() || busy} onClick={saveAndContinue}>Save as Local Preset</button><button type="button" disabled={busy} onClick={() => void switchTo(pendingPosition)}>Discard &amp; Continue</button><button type="button" disabled={busy} onClick={() => setPendingPosition(null)}>Cancel</button></div>
      </div>}
    </aside>
  );
}
