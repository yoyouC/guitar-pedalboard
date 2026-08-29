import { useEffect, useState } from 'react';
import type {
  MarketplaceLikedTargetSummary,
  MarketplaceLikeTargetKind,
  MarketplaceLikeTargetSummary,
  PublishedPresetSearchItem,
} from '../../shared/marketplace.ts';
import { marketplaceClient } from '../marketplace/client.ts';
import { tonePath } from '../marketplace/route.ts';
import { useMemberSession } from '../members/useMemberSession.ts';
import { MarketplaceLikeButton } from './MarketplaceLikeButton.tsx';

type RankingKind = 'popular' | 'trending' | 'latest';

const RANKING_COPY: Record<RankingKind, { title: string; eyebrow: string; explanation: string }> = {
  popular: {
    title: 'Popular',
    eyebrow: 'Most recognized',
    explanation: '按当前有效 Like 总数排序。Tone 与 Collection 独立排名，不读取浏览量、应用次数、音频或演奏行为。',
  },
  trending: {
    title: 'Trending',
    eyebrow: 'Recent recognition',
    explanation: '只根据近期新增的有效 Like 衰减快照排序。没有个性化推荐，也没有人工 Featured。',
  },
  latest: {
    title: 'Latest Tones',
    eyebrow: 'Newest public work',
    explanation: '按公开发布时间展示最新 Tone；Unlisted 与已撤回内容不会进入列表。',
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
    <section className="marketplace-ranking">
      <h2>{title}</h2>
      {items.map((item, index) => (
        <article key={item.id}>
          <strong>#{index + 1}</strong>
          <button type="button" onClick={() => onNavigate(targetPath(kind, item.id))}>{item.title}</button>
          <small>@{item.creator.handle}</small>
          <MarketplaceLikeButton
            kind={kind}
            targetId={item.id}
            targetCreatorId={item.creator.id}
            onNavigate={onNavigate}
          />
        </article>
      ))}
      {!busy && items.length === 0 && <p>这里还没有内容。</p>}
      {cursor && <button type="button" disabled={busy} onClick={onLoadMore}>加载更多</button>}
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
      setMessage(cause instanceof Error ? cause.message : '榜单暂不可用。');
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
      setMessage(cause instanceof Error ? cause.message : '加载失败。');
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
      setMessage(cause instanceof Error ? cause.message : '加载失败。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="marketplace-detail marketplace-ranking-page" aria-live="polite">
      <div className="marketplace-detail__topline">
        <span className="marketplace-detail__eyebrow">Tone Market · {copy.eyebrow}</span>
        <button className="marketplace-detail__close" type="button" onClick={() => onNavigate('/')}>返回效果器</button>
      </div>
      <nav className="marketplace-search__tabs" aria-label="Tone Market discovery views">
        <button type="button" onClick={() => onNavigate('/marketplace')}>Search</button>
        {(['popular', 'trending', 'latest'] as const).map((kind) => (
          <button key={kind} type="button" aria-pressed={ranking === kind} onClick={() => onNavigate(`/marketplace/${kind}`)}>{RANKING_COPY[kind].title}</button>
        ))}
      </nav>
      <div className="marketplace-detail__content">
        <h1>{copy.title}</h1>
        <p className="marketplace-ranking-page__explanation">{copy.explanation}</p>
        {message && <p className="marketplace-detail__error" role="alert">{message}</p>}
        {ranking === 'latest' ? (
          <section className="marketplace-ranking">
            <h2>Tones</h2>
            {latest.map((item) => (
              <article key={item.id}>
                <button type="button" onClick={() => onNavigate(tonePath(item.id))}>{item.title}</button>
                <small>@{item.creator.handle} · {new Date(item.createdAt).toLocaleDateString()}</small>
                <MarketplaceLikeButton kind="preset" targetId={item.id} targetCreatorId={item.creator.id} onNavigate={onNavigate} />
              </article>
            ))}
            {!busy && latest.length === 0 && <p>还没有公开 Tone。</p>}
            {presetCursor && <button type="button" disabled={busy} onClick={() => void loadLatest()}>加载更多</button>}
          </section>
        ) : (
          <div className="marketplace-ranking-grid">
            <RankedSection title="Tones" kind="preset" items={presets} cursor={presetCursor} busy={busy} onNavigate={onNavigate} onLoadMore={() => void loadRanking('preset', presetCursor!)} />
            <RankedSection title="Collections" kind="collection" items={collections} cursor={collectionCursor} busy={busy} onNavigate={onNavigate} onLoadMore={() => void loadRanking('collection', collectionCursor!)} />
          </div>
        )}
      </div>
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
    <section className="marketplace-ranking">
      <h2>{title}</h2>
      {items.map((item) => (
        <article key={item.id}>
          <button type="button" onClick={() => onNavigate(targetPath(kind, item.id))}>{item.title}</button>
          <small>@{item.creator.handle} · liked {new Date(item.likedAt).toLocaleDateString()}</small>
          <MarketplaceLikeButton
            kind={kind}
            targetId={item.id}
            targetCreatorId={item.creator.id}
            onNavigate={onNavigate}
            onChange={(state) => { if (!state.liked) onUnlike(item.id); }}
          />
        </article>
      ))}
      {items.length === 0 && <p>这里还没有内容。</p>}
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
      setMessage(cause instanceof Error ? cause.message : 'My Likes 暂不可用。');
      setLoading(false);
    });
    return () => { active = false; };
  }, [session.status]);

  if (session.status === 'loading') return <p>正在读取 My Likes…</p>;
  if (session.status !== 'authenticated') return (
    <div className="marketplace-search__empty">
      <strong>登录后查看私有 My Likes</strong>
      <p>你的 Like 轨迹只在这里展示，不会出现在 Public Profile。</p>
      <button type="button" onClick={() => onNavigate('/login?return=%2Flibrary%3Ftab%3Dlikes')}>Sign in</button>
    </div>
  );
  return (
    <div>
      <p>My Likes 是私有清单，Tone 与 Collection 分开保存；Public Profile 不会暴露这些轨迹。</p>
      {loading && <p>正在读取 My Likes…</p>}
      {message && <p role="alert">{message}</p>}
      {!loading && !message && <div className="marketplace-ranking-grid">
        <LikedSection title="Liked Tones" kind="preset" items={presets} onNavigate={onNavigate} onUnlike={(id) => setPresets((current) => current.filter((item) => item.id !== id))} />
        <LikedSection title="Liked Collections" kind="collection" items={collections} onNavigate={onNavigate} onUnlike={(id) => setCollections((current) => current.filter((item) => item.id !== id))} />
      </div>}
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
