import { useEffect, useState } from 'react';
import { ArrowLeft, AudioWaveform, Clock, Heart, Layers, LogIn } from 'lucide-react';
import type {
  MarketplaceLikedTargetSummary,
  MarketplaceLikeState,
  MarketplaceLikeTargetKind,
  MarketplaceLikeTargetSummary,
  PublishedPresetSearchItem,
} from '../../shared/marketplace.ts';
import { marketplaceClient } from '../marketplace/client.ts';
import { tonePath } from '../marketplace/route.ts';
import { useMemberSession } from '../members/useMemberSession.ts';
import { MarketplaceLikeButton } from './MarketplaceLikeButton.tsx';
import { EmptyState } from './marketplace-ui/EmptyState.tsx';
import { HashVisual } from './marketplace-ui/HashVisual.tsx';
import { MiniRigChain } from './marketplace-ui/MiniRigChain.tsx';

type RankingKind = 'popular' | 'trending' | 'latest';

const RANKING_COPY: Record<RankingKind, { title: string; eyebrow: string; explanation: string }> = {
  popular: {
    title: 'Popular',
    eyebrow: 'Most recognized',
    explanation: 'Ranked by the current total of active likes. Tones and collections rank independently — no views, applies, audio, or playing behavior are read.',
  },
  trending: {
    title: 'Trending',
    eyebrow: 'Recent recognition',
    explanation: 'Ranked from a decayed snapshot of recently added active likes only. No personalization and no hand-picked featuring.',
  },
  latest: {
    title: 'Latest Tones',
    eyebrow: 'Newest public work',
    explanation: 'Newest public tones by publish time; unlisted and withdrawn work never appears here.',
  },
};

function rankingFromPath(pathname: string): RankingKind | null {
  if (pathname === '/marketplace/popular' || pathname === '/marketplace/popular/') return 'popular';
  if (pathname === '/marketplace/trending' || pathname === '/marketplace/trending/') return 'trending';
  if (pathname === '/marketplace/latest' || pathname === '/marketplace/latest/') return 'latest';
  return null;
}

function targetPath(kind: MarketplaceLikeTargetKind, id: string): string {
  return kind === 'preset'
    ? tonePath(id)
    : `/marketplace/collections/${encodeURIComponent(id)}`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function RankRowsSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="mk-rank-list" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="mk-card mk-rank-row">
          <div className="mk-skeleton" style={{ width: 64, height: 40 }} />
          <div style={{ flex: 1, display: 'grid', gap: 6 }}>
            <div className="mk-skeleton" style={{ height: 14, width: '45%' }} />
            <div className="mk-skeleton" style={{ height: 11, width: '30%' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function SummaryRow({
  rank,
  kind,
  item,
  metaExtra,
  onNavigate,
  onChange,
}: {
  rank?: number;
  kind: MarketplaceLikeTargetKind;
  item: MarketplaceLikeTargetSummary;
  metaExtra?: string;
  onNavigate(pathname: string): void;
  onChange?(state: MarketplaceLikeState): void;
}) {
  return (
    <article className="mk-card mk-card--interactive mk-rank-row">
      <button
        type="button"
        className="mk-rank-row__main"
        onClick={() => onNavigate(targetPath(kind, item.id))}
      >
        {rank !== undefined && (
          <span className={rank <= 3 ? 'mk-rank-row__rank mk-rank-row__rank--top' : 'mk-rank-row__rank'}>
            {String(rank).padStart(2, '0')}
          </span>
        )}
        <HashVisual seed={item.id} className="mk-rank-row__thumb">
          {kind === 'collection' && <Layers size={16} strokeWidth={1.5} />}
        </HashVisual>
        <span className="mk-rank-row__text">
          <span className="mk-rank-row__title">{item.title}</span>
          <span className="mk-rank-row__meta">@{item.creator.handle}{metaExtra ? ` · ${metaExtra}` : ''}</span>
        </span>
        <span className="mk-rank-row__likes">
          <Heart size={12} aria-hidden="true" />
          {item.likeCount}
        </span>
      </button>
      <MarketplaceLikeButton
        kind={kind}
        targetId={item.id}
        targetCreatorId={item.creator.id}
        onNavigate={onNavigate}
        onChange={onChange}
        hideHints
      />
    </article>
  );
}

function LatestRow({ rank, item, onNavigate }: {
  rank: number;
  item: PublishedPresetSearchItem;
  onNavigate(pathname: string): void;
}) {
  return (
    <article className="mk-card mk-card--interactive mk-rank-row">
      <button
        type="button"
        className="mk-rank-row__main"
        onClick={() => onNavigate(tonePath(item.id))}
      >
        <span className={rank <= 3 ? 'mk-rank-row__rank mk-rank-row__rank--top' : 'mk-rank-row__rank'}>
          {String(rank).padStart(2, '0')}
        </span>
        <span className="mk-rank-row__thumb mk-rank-row__thumb--rig">
          <MiniRigChain
            pedalIds={item.derivedAttributes.pedalIds}
            ampId={item.derivedAttributes.ampId}
            seed={item.id}
            compact
          />
        </span>
        <span className="mk-rank-row__text">
          <span className="mk-rank-row__title">{item.title}</span>
          <span className="mk-rank-row__meta">@{item.creator.handle} · {formatDate(item.createdAt)}</span>
        </span>
      </button>
      <MarketplaceLikeButton kind="preset" targetId={item.id} targetCreatorId={item.creator.id} onNavigate={onNavigate} hideHints />
    </article>
  );
}

function RankedSection({
  title,
  kind,
  items,
  cursor,
  busy,
  onNavigate,
  onLoadMore,
}: {
  title: string;
  kind: MarketplaceLikeTargetKind;
  items: MarketplaceLikeTargetSummary[];
  cursor: string | null;
  busy: boolean;
  onNavigate(pathname: string): void;
  onLoadMore(): void;
}) {
  return (
    <section className="mk-rank-section" aria-label={title}>
      <h2 className="mk-detail__section-title">
        {title}
        <span className="mk-rank-section__count">{items.length}</span>
      </h2>
      {busy && items.length === 0 ? <RankRowsSkeleton /> : (
        <div className="mk-rank-list">
          {items.map((item, index) => (
            <SummaryRow key={item.id} rank={index + 1} kind={kind} item={item} onNavigate={onNavigate} />
          ))}
        </div>
      )}
      {!busy && items.length === 0 && (
        <EmptyState
          icon={kind === 'preset' ? AudioWaveform : Layers}
          title={`No ${kind === 'preset' ? 'tones' : 'collections'} ranked yet`}
          hint="Likes from the community decide the ranking."
        />
      )}
      {cursor && (
        <div className="mk-browse__more">
          <button type="button" className="mk-btn mk-btn--secondary" disabled={busy} onClick={onLoadMore}>Load more</button>
        </div>
      )}
    </section>
  );
}

export function MarketplaceRankingPage({ pathname, onNavigate }: {
  pathname: string;
  onNavigate(pathname: string): void;
}) {
  const ranking = rankingFromPath(pathname);
  const [presets, setPresets] = useState<MarketplaceLikeTargetSummary[]>([]);
  const [collections, setCollections] = useState<MarketplaceLikeTargetSummary[]>([]);
  const [latest, setLatest] = useState<PublishedPresetSearchItem[]>([]);
  const [presetCursor, setPresetCursor] = useState<string | null>(null);
  const [collectionCursor, setCollectionCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!ranking) return;
    let active = true;
    setBusy(true);
    setMessage('');
    setPresets([]);
    setCollections([]);
    setLatest([]);
    const request = ranking === 'latest'
      ? marketplaceClient.searchPublishedPresets({ limit: 12 }).then((page) => ({
        latest: page.items,
        presetCursor: page.nextCursor,
        collections: [],
        collectionCursor: null,
      }))
      : Promise.all([
        ranking === 'popular' ? marketplaceClient.listPopular('preset') : marketplaceClient.listTrending('preset'),
        ranking === 'popular' ? marketplaceClient.listPopular('collection') : marketplaceClient.listTrending('collection'),
      ]).then(([tonePage, collectionPage]) => ({
        latest: [],
        presets: tonePage.items,
        presetCursor: tonePage.nextCursor,
        collections: collectionPage.items,
        collectionCursor: collectionPage.nextCursor,
      }));
    void request.then((result) => {
      if (!active) return;
      setLatest(result.latest);
      setPresets('presets' in result ? result.presets : []);
      setCollections(result.collections);
      setPresetCursor(result.presetCursor);
      setCollectionCursor(result.collectionCursor);
      setBusy(false);
    }, (cause: unknown) => {
      if (!active) return;
      setMessage(cause instanceof Error ? cause.message : 'Rankings are unavailable.');
      setBusy(false);
    });
    return () => { active = false; };
  }, [ranking]);

  useEffect(() => {
    if (!ranking) return;
    const previous = document.title;
    document.title = `${RANKING_COPY[ranking].title} · Guitar Pedalboard`;
    return () => { document.title = previous; };
  }, [ranking]);

  if (!ranking) return null;
  const copy = RANKING_COPY[ranking];
  const loadRanking = async (kind: MarketplaceLikeTargetKind, cursor: string) => {
    setBusy(true);
    setMessage('');
    try {
      const page = ranking === 'popular'
        ? await marketplaceClient.listPopular(kind, { cursor })
        : await marketplaceClient.listTrending(kind, { cursor });
      if (kind === 'preset') {
        setPresets((current) => [...current, ...page.items]);
        setPresetCursor(page.nextCursor);
      } else {
        setCollections((current) => [...current, ...page.items]);
        setCollectionCursor(page.nextCursor);
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Load failed.');
    } finally {
      setBusy(false);
    }
  };
  const loadLatest = async () => {
    if (!presetCursor) return;
    setBusy(true);
    setMessage('');
    try {
      const page = await marketplaceClient.searchPublishedPresets({ limit: 12, cursor: presetCursor });
      setLatest((current) => [...current, ...page.items]);
      setPresetCursor(page.nextCursor);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Load failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mk-page" aria-live="polite">
      <div className="mk-detail__topline">
        <span className="mk-detail__eyebrow">Tone Market · {copy.eyebrow}</span>
        <button className="mk-btn mk-btn--ghost" type="button" onClick={() => onNavigate('/')}>
          <ArrowLeft size={15} aria-hidden="true" />
          Back to pedalboard
        </button>
      </div>

      <nav className="mk-browse__views" aria-label="Tone Market discovery views">
        <button type="button" className="mk-browse__view" onClick={() => onNavigate('/marketplace')}>Search</button>
        {(['popular', 'trending', 'latest'] as const).map((kind) => (
          <button key={kind} type="button" className="mk-browse__view" aria-pressed={ranking === kind} onClick={() => onNavigate(`/marketplace/${kind}`)}>{RANKING_COPY[kind].title}</button>
        ))}
      </nav>

      <header className="mk-browse__heading">
        <h1 className="mk-browse__title">{copy.title}</h1>
        {!busy && !message && (
          <span className="mk-browse__count">
            {ranking === 'latest' ? `${latest.length} tones` : `${presets.length + collections.length} entries`}
          </span>
        )}
      </header>
      <p className="mk-page__explanation">{copy.explanation}</p>

      {message && (
        <div className="mk-browse__error" role="alert">
          <strong>Ranking unavailable</strong>
          <p>{message}</p>
        </div>
      )}

      {ranking === 'latest' ? (
        <section className="mk-rank-section" aria-label="Latest tones">
          <h2 className="mk-detail__section-title">
            Tones
            <span className="mk-rank-section__count">{latest.length}</span>
          </h2>
          {busy && latest.length === 0 ? <RankRowsSkeleton /> : (
            <div className="mk-rank-list">
              {latest.map((item, index) => (
                <LatestRow key={item.id} rank={index + 1} item={item} onNavigate={onNavigate} />
              ))}
            </div>
          )}
          {!busy && latest.length === 0 && !message && (
            <EmptyState icon={Clock} title="No public tones yet" hint="New public work appears here first." />
          )}
          {presetCursor && (
            <div className="mk-browse__more">
              <button type="button" className="mk-btn mk-btn--secondary" disabled={busy} onClick={() => void loadLatest()}>Load more</button>
            </div>
          )}
        </section>
      ) : (
        <div className="mk-rank-sections">
          <RankedSection title="Tones" kind="preset" items={presets} cursor={presetCursor} busy={busy} onNavigate={onNavigate} onLoadMore={() => void loadRanking('preset', presetCursor!)} />
          <RankedSection title="Collections" kind="collection" items={collections} cursor={collectionCursor} busy={busy} onNavigate={onNavigate} onLoadMore={() => void loadRanking('collection', collectionCursor!)} />
        </div>
      )}
    </section>
  );
}

function LikedSection({
  title,
  kind,
  items,
  onNavigate,
  onUnlike,
}: {
  title: string;
  kind: MarketplaceLikeTargetKind;
  items: MarketplaceLikedTargetSummary[];
  onNavigate(pathname: string): void;
  onUnlike(id: string): void;
}) {
  return (
    <section className="mk-rank-section" aria-label={title}>
      <h2 className="mk-detail__section-title">
        {title}
        <span className="mk-rank-section__count">{items.length}</span>
      </h2>
      <div className="mk-rank-list">
        {items.map((item) => (
          <SummaryRow
            key={item.id}
            kind={kind}
            item={item}
            metaExtra={`liked ${formatDate(item.likedAt)}`}
            onNavigate={onNavigate}
            onChange={(state) => { if (!state.liked) onUnlike(item.id); }}
          />
        ))}
      </div>
      {items.length === 0 && (
        <EmptyState
          icon={kind === 'preset' ? AudioWaveform : Layers}
          title="Nothing here yet"
          hint="Likes you make while signed in are collected here."
        />
      )}
    </section>
  );
}

export function MarketplaceMyLikesPanel({ onNavigate }: { onNavigate(pathname: string): void }) {
  const session = useMemberSession();
  const [presets, setPresets] = useState<MarketplaceLikedTargetSummary[]>([]);
  const [collections, setCollections] = useState<MarketplaceLikedTargetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (session.status !== 'authenticated') {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setMessage('');
    void marketplaceClient.getMyLikes().then((likes) => {
      if (!active) return;
      setPresets(likes.presets);
      setCollections(likes.collections);
      setLoading(false);
    }, (cause: unknown) => {
      if (!active) return;
      setMessage(cause instanceof Error ? cause.message : 'My Likes is unavailable.');
      setLoading(false);
    });
    return () => { active = false; };
  }, [session.status]);

  if (session.status === 'loading') return <RankRowsSkeleton count={3} />;
  if (session.status !== 'authenticated') return (
    <div className="mk-my-likes-signin">
      <EmptyState
        icon={LogIn}
        title="Sign in to view your private My Likes"
        hint="Your like activity only appears here — never on your Public Profile."
      />
      <div className="mk-browse__more">
        <button type="button" className="mk-btn mk-btn--primary" onClick={() => onNavigate('/login?return=%2Flibrary%3Ftab%3Dlikes')}>Sign in</button>
      </div>
    </div>
  );
  return (
    <div className="mk-my-likes">
      <p className="mk-page__explanation">
        My Likes is a private list — tones and collections are kept separately, and your Public
        Profile never exposes this activity.
      </p>
      {loading && <RankRowsSkeleton count={3} />}
      {message && <p role="alert">{message}</p>}
      {!loading && !message && (
        <div className="mk-rank-sections">
          <LikedSection title="Liked Tones" kind="preset" items={presets} onNavigate={onNavigate} onUnlike={(id) => setPresets((current) => current.filter((item) => item.id !== id))} />
          <LikedSection title="Liked Collections" kind="collection" items={collections} onNavigate={onNavigate} onUnlike={(id) => setCollections((current) => current.filter((item) => item.id !== id))} />
        </div>
      )}
    </div>
  );
}

export function MarketplaceLikesRoute({ pathname, onNavigate }: {
  pathname: string;
  onClose(): void;
  onNavigate(pathname: string): void;
}) {
  return <MarketplaceRankingPage pathname={pathname} onNavigate={onNavigate} />;
}
