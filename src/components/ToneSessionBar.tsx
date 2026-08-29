import { useState } from 'react';
import { toneSession, useToneSession } from '../marketplace/toneSession';

export function ToneSessionBar() {
  const session = useToneSession();
  const [message, setMessage] = useState('');
  if (!session.tone) return null;
  const restore = async () => {
    const result = await toneSession.backToOriginal();
    if (!result.ok) setMessage(result.message ?? '无法恢复 My Original Rig。');
  };
  return (
    <aside className="tone-session-bar" aria-label="Tone Market session">
      <div>
        <strong>{session.tone.title}</strong>
        <span>@{session.tone.creator.handle} · fixed revision {session.tone.revisionId}</span>
      </div>
      {session.modified && <span className="tone-session-bar__modified">Modified</span>}
      <button type="button" onClick={() => void restore()}>Back to My Rig</button>
      <button type="button" onClick={() => toneSession.exit()}>Exit Session</button>
      {message && <span role="alert">{message}</span>}
    </aside>
  );
}
