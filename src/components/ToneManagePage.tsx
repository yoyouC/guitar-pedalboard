import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { PublishedPreset } from '../../shared/marketplace';
import { marketplaceClient } from '../marketplace/client';
import { PublishedPresetManager } from './PublishedPresetManager';

interface Props { pathname: string; onNavigate(pathname: string): void }
export function ToneManagePage({ pathname, onNavigate }: Props) {
  const match = /^\/library\/tones\/([^/]+)\/?$/.exec(pathname);
  const id = match ? decodeURIComponent(match[1]) : '';
  const [preset, setPreset] = useState<PublishedPreset | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    void marketplaceClient.getManagedPublishedPreset(id).then((value) => { if (active) setPreset(value); }, (cause: unknown) => { if (active) setMessage(cause instanceof Error ? cause.message : 'Manage is unavailable.'); });
    return () => { active = false; };
  }, [id]);
  return (
    <section className="mk-page">
      <div className="mk-detail__topline">
        <span className="mk-detail__eyebrow">My Tones · Manage</span>
        <button type="button" className="mk-btn mk-btn--ghost" onClick={() => onNavigate('/library')}>
          <ArrowLeft size={15} aria-hidden="true" />
          My Tones
        </button>
      </div>
      {message && <p role="alert" className="mk-detail__action-message">{message}</p>}
      {!preset && !message && <p className="mk-page__explanation">Loading tone management data…</p>}
      {preset && (
        <>
          <h1 className="mk-detail__title">{preset.title}</h1>
          <p className="mk-page__explanation">
            Concurrency conflicts keep the current form and ask you to reload — no blind overwrites.
          </p>
          <PublishedPresetManager preset={preset} onUpdated={setPreset} onNavigate={onNavigate} />
        </>
      )}
    </section>
  );
}
