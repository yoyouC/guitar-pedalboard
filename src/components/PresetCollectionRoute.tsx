import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { ArrowLeft, Play } from 'lucide-react';
import type { PresetCollection, PublishedPresetRevisionCompatibility } from '../../shared/marketplace';
import { collectionQueue } from '../marketplace/collectionQueueSession';
import { marketplaceClient } from '../marketplace/client';
import { presetCollectionIdFromPath, toneRevisionPath } from '../marketplace/route';
import { useMarketplacePageMetadata } from '../marketplace/pageMetadata';
import { useToneSession } from '../marketplace/toneSession';
import { rigStore } from '../state/useRig';
import { MarketplaceLikeButton } from './MarketplaceLikeButton';
import { MarketplaceReportForm } from './MarketplaceReportForm';
import {
  compatibilityBlockerMessage,
  resolvePublishedRevisionCompatibility,
} from '../marketplace/revisionCompatibility';
import { browserTone3000Compatibility } from '../marketplace/revisionCompatibilityBrowser';
import { browserPedalboardCapability } from '../marketplace/pedalboardCapability';
import { ShareLinkFallback } from './ShareLinkFallback';
import { TagBadge } from './marketplace-ui/TagBadge.tsx';
import { hueFromString } from './marketplace-ui/hash.ts';

interface PresetCollectionRouteProps {
  pathname: string;
  onClose(): void;
  onNavigate(pathname: string): void;
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; collection: PresetCollection }
  | { status: 'error'; message: string };

type ItemCompatibilityState =
  | { status: 'checking' }
  | { status: 'error'; message: string }
  | { status: 'ready'; value: PublishedPresetRevisionCompatibility };

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function initials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts.slice(0, 2).map((part) => part[0]).join('');
}

export function PresetCollectionRoute({ pathname, onClose, onNavigate }: PresetCollectionRouteProps) {
  const collectionId = presetCollectionIdFromPath(pathname);
  const queue = useSyncExternalStore(collectionQueue.subscribe, collectionQueue.getState);
  const tone = useToneSession();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const [startPosition, setStartPosition] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [itemCompatibility, setItemCompatibility] = useState<Record<number, ItemCompatibilityState>>({});
  const capability = browserPedalboardCapability();

  useEffect(() => {
    if (!collectionId) return;
    let active = true;
    setState({ status: 'loading' });
    void marketplaceClient.getPresetCollection(collectionId).then((collection) => {
      if (!active) return;
      setState({ status: 'ready', collection });
      setStartPosition(null);
      setItemCompatibility(Object.fromEntries(collection.items.map((item) => [
        item.position,
        item.availability === 'available'
          ? { status: 'checking' as const }
          : { status: 'error' as const, message: 'Original tone is unavailable' },
      ])));
      void Promise.all(collection.items.map(async (item) => {
        if (item.availability !== 'available') return [item.position, {
          status: 'error' as const, message: 'Original tone is unavailable',
        }] as const;
        try {
          const revision = await marketplaceClient.getPublishedPresetRevision(
            item.presetId,
            item.revisionId,
          );
          return [item.position, {
            status: 'ready' as const,
            value: await resolvePublishedRevisionCompatibility(
              revision.revision,
              browserTone3000Compatibility,
            ),
          }] as const;
        } catch (cause) {
          return [item.position, {
            status: 'error' as const,
            message: cause instanceof Error ? cause.message : 'Compatibility check failed',
          }] as const;
        }
      })).then((entries) => {
        if (!active) return;
        const compatibility = Object.fromEntries(entries);
        setItemCompatibility(compatibility);
        setStartPosition(collection.items.find((item) => (
          compatibility[item.position]?.status === 'ready'
          && compatibility[item.position].value.status === 'compatible'
        ))?.position ?? null);
      });
    }, (cause: unknown) => {
      if (active) setState({
        status: 'error',
        message: cause instanceof Error ? cause.message : 'The collection is unavailable.',
      });
    });
    return () => { active = false; };
  }, [collectionId, attempt]);

  useMarketplacePageMetadata(state.status === 'ready' ? {
    kind: 'collection',
    id: state.collection.id,
    title: state.collection.title,
    description: state.collection.description,
    visibility: state.collection.visibility === 'hidden' ? 'withdrawn' : state.collection.visibility,
  } : null);

  const launchCollection = async (collection: PresetCollection) => {
    if (startPosition === null) return;
    setBusy(true);
    setMessage('');
    const blockedReasons = Object.fromEntries(collection.items.flatMap((item) => {
      const state = itemCompatibility[item.position];
      if (state?.status === 'ready' && state.value.status === 'compatible') return [];
      const reason = state?.status === 'ready'
        ? state.value.blockers.map(compatibilityBlockerMessage).join('; ')
        : state?.status === 'error'
          ? state.message
          : 'Compatibility not confirmed yet';
      return [[item.position, reason]];
    }));
    const result = await collectionQueue.start(collection, startPosition, blockedReasons);
    setBusy(false);
    if (result.ok) onNavigate('/');
    else setMessage(result.message ?? 'Could not start the collection queue.');
  };
  const requestLaunch = (collection: PresetCollection) => {
    if (tone.modified) {
      setPresetName(`${tone.tone?.title ?? 'Tone'} edit`);
      setConfirmReplace(true);
      return;
    }
    void launchCollection(collection);
  };

  if (!collectionId) return null;
  const activeQueue = queue.queue;
  return (
    <section className="mk-page" aria-live="polite">
      <div className="mk-detail__topline">
        <span className="mk-detail__eyebrow">Tone Market · Collection</span>
        <button className="mk-btn mk-btn--ghost" type="button" onClick={onClose}>
          <ArrowLeft size={15} aria-hidden="true" />
          Back to pedalboard
        </button>
      </div>

      {state.status === 'idle' || state.status === 'loading' ? (
        <div className="mk-detail__skeleton" aria-hidden="true">
          <div className="mk-skeleton" style={{ height: 30, width: '40%' }} />
          <div className="mk-skeleton" style={{ height: 14, width: '25%' }} />
          <div className="mk-skeleton" style={{ height: 48, width: '70%' }} />
          <div className="mk-skeleton" style={{ height: 220, width: '100%' }} />
        </div>
      ) : state.status === 'error' ? (
        <div className="mk-detail__error" role="alert">
          <strong>Could not open this collection</strong>
          <p>{state.message}</p>
          <div>
            <button type="button" className="mk-btn mk-btn--secondary" onClick={() => setAttempt((current) => current + 1)}>Retry</button>
          </div>
        </div>
      ) : (
        <>
          <header className="mk-detail__head">
            <h1 className="mk-detail__title">{state.collection.title}</h1>
            <button
              type="button"
              className="mk-detail__creator"
              onClick={() => onNavigate(
                `/creators/id/${encodeURIComponent(state.collection.creator.id)}`,
              )}
            >
              <span
                className="mk-avatar"
                style={{ '--mk-avatar-hue': hueFromString(state.collection.creator.handle) } as CSSProperties}
                aria-hidden="true"
              >
                {initials(state.collection.creator.displayName)}
              </span>
              <span className="mk-detail__creator-name">{state.collection.creator.displayName}</span>
              <span className="mk-detail__creator-handle">@{state.collection.creator.handle}</span>
            </button>
            <p className="mk-detail__meta">
              Updated {formatDate(state.collection.updatedAt)} · {state.collection.items.length}{' '}
              {state.collection.items.length === 1 ? 'tone' : 'tones'}
            </p>
            <p className="mk-detail__description">
              {state.collection.description || 'No description provided.'}
            </p>
            {state.collection.tags.length > 0 && (
              <div className="mk-detail__tags">
                {state.collection.tags.map((tag) => <TagBadge key={tag.id} label={tag.nameEn} />)}
              </div>
            )}
            <div className="mk-collection__actions">
              {state.collection.visibility !== 'withdrawn' && (
                <MarketplaceLikeButton kind="collection" targetId={state.collection.id} targetCreatorId={state.collection.creator.id} onNavigate={onNavigate} />
              )}
              {(state.collection.visibility === 'public' || state.collection.visibility === 'unlisted') && (
                <MarketplaceReportForm kind="collection" targetId={state.collection.id} onNavigate={onNavigate} />
              )}
            </div>
            {state.collection.visibility !== 'public' && (
              <p className="mk-notice">
                {state.collection.visibility === 'unlisted'
                  ? 'Unlisted — only people with the direct link can open this collection.'
                  : 'This collection has been withdrawn. Only the author can manage it.'}
              </p>
            )}
          </header>

          <section className="mk-card mk-collection-panel" aria-label="Collection queue preview">
            <div className="mk-collection-panel__intro">
              <h2 className="mk-detail__section-title">Play this collection</h2>
              <p>
                The queue lives only in this browser session; unavailable positions are kept and
                skipped as you move through them.
              </p>
            </div>
            <ol className="mk-collection-items">
              {state.collection.items.map((item) => {
                const current = activeQueue?.collectionId === state.collection.id
                  && activeQueue.currentPosition === item.position;
                const compatibility = itemCompatibility[item.position];
                const usable = compatibility?.status === 'ready'
                  && compatibility.value.status === 'compatible';
                const compatibilityText = compatibility?.status === 'checking'
                  ? 'Checking compatibility…'
                  : compatibility?.status === 'error'
                    ? compatibility.message ?? 'Unavailable'
                    : compatibility
                      ? compatibility.value.status === 'compatible'
                        ? 'Fully compatible'
                        : compatibility.value.blockers.map(compatibilityBlockerMessage).join('; ')
                      : 'Pending check';
                return (
                  <li
                    key={`${item.position}-${item.presetId}-${item.revisionId}`}
                    className={usable ? 'mk-collection-item' : 'mk-collection-item mk-collection-item--unavailable'}
                  >
                    <input
                      type="radio"
                      name="collection-start"
                      aria-label={`Start from position ${item.position + 1}`}
                      disabled={!usable}
                      checked={startPosition === item.position}
                      onChange={() => setStartPosition(item.position)}
                    />
                    <span className="mk-collection-item__position">{String(item.position + 1).padStart(2, '0')}</span>
                    <div className="mk-collection-item__main">
                      {item.availability === 'available' ? (
                        <button type="button" className="mk-collection-item__title" onClick={() => onNavigate(toneRevisionPath(item.presetId, item.revisionId))}>
                          {item.title}
                        </button>
                      ) : (
                        <span className="mk-collection-item__title">
                          Original tone unavailable
                          <span className="mk-badge mk-badge--warning">Unavailable</span>
                        </span>
                      )}
                      <small>
                        @{item.creator.handle} · fixed revision {item.revisionId}
                        {current ? ' · Now playing' : ''}
                      </small>
                      <small className={usable ? 'mk-collection-item__compat mk-collection-item__compat--ok' : 'mk-collection-item__compat'}>
                        {compatibilityText}
                      </small>
                    </div>
                  </li>
                );
              })}
            </ol>
            {state.collection.items.length === 0 && (
              <p className="mk-collection-panel__empty">This collection has no items yet.</p>
            )}
            <button
              type="button"
              className="mk-btn mk-btn--primary mk-collection-panel__cta"
              disabled={busy || startPosition === null || !capability.supported}
              onClick={() => requestLaunch(state.collection)}
            >
              <Play size={15} aria-hidden="true" />
              {busy ? 'Loading fixed revisions…' : 'Use Collection in Pedalboard'}
            </button>
            {!capability.supported && (
              <div className="mk-detail__capability">
                <strong>This browser does not support the Pedalboard audio runtime</strong>
                <span>Missing: {capability.missing.join(', ')}.</span>
                <ShareLinkFallback pathname={pathname} label="Collection" />
              </div>
            )}
            {confirmReplace && (
              <div className="mk-collection-panel__decision" role="dialog" aria-modal="true" aria-label="Current tone has unsaved changes">
                <strong>Current tone has unsaved changes</strong>
                <p>Starting a new queue discards these edits.</p>
                <label>
                  Local Preset name
                  <input className="mk-input" value={presetName} onChange={(event) => setPresetName(event.target.value)} />
                </label>
                <div className="mk-collection-panel__decision-actions">
                  <button type="button" className="mk-btn mk-btn--secondary" disabled={!presetName.trim() || busy} onClick={() => { rigStore.savePreset(presetName.trim()); setConfirmReplace(false); void launchCollection(state.collection); }}>Save as Local Preset</button>
                  <button type="button" className="mk-btn mk-btn--secondary" disabled={busy} onClick={() => { setConfirmReplace(false); void launchCollection(state.collection); }}>Discard &amp; Continue</button>
                  <button type="button" className="mk-btn mk-btn--ghost" disabled={busy} onClick={() => setConfirmReplace(false)}>Cancel</button>
                </div>
              </div>
            )}
            {message && <p role="alert" className="mk-detail__action-message">{message}</p>}
          </section>
        </>
      )}
    </section>
  );
}
