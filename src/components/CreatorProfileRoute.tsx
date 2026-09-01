import { useEffect, useState, type CSSProperties } from 'react';
import { ArrowLeft, AudioWaveform } from 'lucide-react';
import type { PublicCreatorProfile, PublicCreatorWorkSummary } from '../../shared/members.ts';
import {
  fetchPublicCreator,
  fetchPublicCreatorById,
  fetchPublicCreatorWorks,
  fetchPublicCreatorWorksById,
} from '../members/client.ts';
import { loadCreatorProfile } from '../members/loadCreatorProfile.ts';
import { useMarketplacePageMetadata } from '../marketplace/pageMetadata.ts';
import { creatorRouteFromPath } from '../marketplace/route.ts';
import { MarketplaceReportForm } from './MarketplaceReportForm.tsx';
import { EmptyState } from './marketplace-ui/EmptyState.tsx';
import { HashVisual } from './marketplace-ui/HashVisual.tsx';
import { hueFromString } from './marketplace-ui/hash.ts';

interface CreatorProfileRouteProps {
  pathname: string;
  onClose(): void;
  onNavigate(pathname: string): void;
}

function initials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts.slice(0, 2).map((part) => part[0]).join('');
}

export function CreatorProfileRoute({ pathname, onClose, onNavigate }: CreatorProfileRouteProps) {
  const route = creatorRouteFromPath(pathname);
  const memberId = route?.memberId ?? null;
  const handle = route?.handle ?? null;
  const identity = memberId ?? handle;
  const [creator, setCreator] = useState<PublicCreatorProfile | null>(null);
  const [error, setError] = useState('');
  const [works, setWorks] = useState<PublicCreatorWorkSummary[]>([]);

  useEffect(() => {
    setCreator(null);
    setError('');
    setWorks([]);
    if (!identity) return;
    return loadCreatorProfile(identity, {
      fetchCreator: memberId ? fetchPublicCreatorById : fetchPublicCreator,
      fetchWorks: memberId ? fetchPublicCreatorWorksById : fetchPublicCreatorWorks,
      onLoaded(nextCreator, nextWorks) {
        setCreator(nextCreator);
        setWorks(nextWorks);
        if (!memberId) {
          onNavigate(`/creators/id/${encodeURIComponent(nextCreator.id)}`);
        }
      },
      onError(cause) {
        setError(cause instanceof Error ? cause.message : 'Could not load this creator');
      },
    });
  }, [handle, identity, memberId, onNavigate]);

  useMarketplacePageMetadata(creator ? {
    kind: 'creator',
    id: creator.id,
    title: creator.displayName,
    description: creator.bio || `@${creator.handle} · Guitar Pedalboard creator`,
    visibility: 'public',
  } : null);

  if (!route) return null;
  return (
    <section className="mk-page" aria-label="Public creator profile">
      <div className="mk-detail__topline">
        <span className="mk-detail__eyebrow">Tone Market · Creator</span>
        <button type="button" className="mk-btn mk-btn--ghost" onClick={onClose}>
          <ArrowLeft size={15} aria-hidden="true" />
          Back to pedalboard
        </button>
      </div>

      {!creator && !error && (
        <div className="mk-detail__skeleton" aria-hidden="true">
          <div className="mk-skeleton" style={{ height: 96, width: '100%', borderRadius: 14 }} />
          <div className="mk-skeleton" style={{ height: 14, width: '30%' }} />
        </div>
      )}
      {error && (
        <div className="mk-detail__error" role="alert">
          <strong>Could not load this creator</strong>
          <p>{error}</p>
        </div>
      )}
      {creator && (
        <>
          <header className="mk-card mk-profile">
            {creator.avatarUrl ? (
              <img className="mk-profile__avatar" src={creator.avatarUrl} alt="" referrerPolicy="no-referrer" />
            ) : (
              <span
                className="mk-avatar mk-profile__avatar"
                style={{ '--mk-avatar-hue': hueFromString(creator.handle) } as CSSProperties}
                aria-hidden="true"
              >
                {initials(creator.displayName)}
              </span>
            )}
            <div className="mk-profile__main">
              <h1 className="mk-detail__title">{creator.displayName}</h1>
              <p className="mk-detail__meta">@{creator.handle}</p>
              {creator.bio && <p className="mk-detail__description">{creator.bio}</p>}
            </div>
          </header>

          <section className="mk-detail__section" aria-label="Public works">
            <h2 className="mk-detail__section-title">
              Public works
              <span className="mk-rank-section__count">{works.length}</span>
            </h2>
            {works.length === 0 ? (
              <EmptyState
                icon={AudioWaveform}
                title="No public works yet"
                hint="Published tones and collections from this creator appear here."
              />
            ) : (
              <div className="mk-grid">
                {works.map((work) => (
                  <button
                    type="button"
                    key={work.id}
                    className="mk-card mk-card--interactive mk-collection-card"
                    onClick={() => onNavigate(work.url)}
                  >
                    <HashVisual seed={work.id} className="mk-collection-card__visual" />
                    <div className="mk-preset-card__body">
                      <h3 className="mk-preset-card__title">{work.title}</h3>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>

          <div className="mk-detail__report">
            <MarketplaceReportForm kind="member" targetId={creator.id} onNavigate={onNavigate} />
          </div>
        </>
      )}
    </section>
  );
}
