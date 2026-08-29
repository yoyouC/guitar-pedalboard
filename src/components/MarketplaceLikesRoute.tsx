import { useEffect, useState } from 'react';
import type {
  MarketplaceLikeTargetKind,
  MarketplaceLikeTargetSummary,
  MarketplaceMyLikes,
} from '../../shared/marketplace';
import { marketplaceClient } from '../marketplace/client';

export function MarketplaceLikesRoute({ pathname, onClose, onNavigate }: {
  pathname: string;
  onClose(): void;
  onNavigate(pathname: string): void;
}) {
  const popular = pathname === '/marketplace/popular' || pathname === '/marketplace/popular/';
  const mine = pathname === '/marketplace/me/likes' || pathname === '/marketplace/me/likes/';
  const [presets, setPresets] = useState<MarketplaceLikeTargetSummary[]>([]);
  const [collections, setCollections] = useState<MarketplaceLikeTargetSummary[]>([]);
  const [presetCursor, setPresetCursor] = useState<string | null>(null);
  const [collectionCursor, setCollectionCursor] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const targetState = {
    preset: { append: setPresets, setCursor: setPresetCursor },
    collection: { append: setCollections, setCursor: setCollectionCursor },
  } satisfies Record<MarketplaceLikeTargetKind, {
    append: typeof setPresets;
    setCursor: typeof setPresetCursor;
  }>;

  useEffect(() => {
    if (!popular && !mine) return;
    let active = true;
    setMessage('');
    const load = mine
      ? marketplaceClient.getMyLikes().then((likes: MarketplaceMyLikes) => likes)
      : Promise.all([
        marketplaceClient.listPopular('preset'),
        marketplaceClient.listPopular('collection'),
      ]).then(([presetPage, collectionPage]) => ({
        presets: presetPage.items, collections: collectionPage.items,
        presetCursor: presetPage.nextCursor, collectionCursor: collectionPage.nextCursor,
      }));
    void load.then(
      (value) => {
        if (!active) return;
        setPresets(value.presets);
        setCollections(value.collections);
        setPresetCursor('presetCursor' in value ? value.presetCursor : null);
        setCollectionCursor('collectionCursor' in value ? value.collectionCursor : null);
      },
      (cause: unknown) => {
        if (active) setMessage(cause instanceof Error ? cause.message : '列表暂不可用。');
      },
    );
    return () => { active = false; };
  }, [mine, popular]);

  useEffect(() => {
    if (!popular && !mine) return;
    const previous = document.title;
    document.title = `${mine ? '我的点赞' : '热门内容'} · Guitar Pedalboard`;
    return () => { document.title = previous; };
  }, [mine, popular]);

  if (!popular && !mine) return null;
  const section = (
    title: string,
    kind: MarketplaceLikeTargetKind,
    items: MarketplaceLikeTargetSummary[],
    cursor: string | null,
  ) => (
    <section className="marketplace-ranking">
      <h3>{title}</h3>
      {items.map((item, index) => (
        <article key={item.id}>
          <strong>#{index + 1}</strong>
          <button type="button" onClick={() => onNavigate(targetPath(kind, item.id))}>
            {item.title}
          </button>
          <small>@{item.creator.handle} · ♥ {item.likeCount}</small>
        </article>
      ))}
      {items.length === 0 && !message && <p>这里还没有内容。</p>}
      {popular && cursor && (
        <button type="button" onClick={() => void marketplaceClient.listPopular(kind, { cursor }).then((page) => {
          targetState[kind].append((current) => [...current, ...page.items]);
          targetState[kind].setCursor(page.nextCursor);
        }, (cause: unknown) => setMessage(cause instanceof Error ? cause.message : '加载失败'))}>
          加载更多
        </button>
      )}
    </section>
  );
  return (
    <section className="marketplace-detail" aria-live="polite">
      <div className="marketplace-detail__topline">
        <span className="marketplace-detail__eyebrow">音色广场 · {mine ? 'My Likes' : 'Popular'}</span>
        <button className="marketplace-detail__close" type="button" onClick={onClose}>返回效果器</button>
      </div>
      <div className="marketplace-detail__content">
        <h2>{mine ? '我的点赞' : '热门内容'}</h2>
        {message && <p className="marketplace-detail__error" role="alert">{message}</p>}
        <div className="marketplace-ranking-grid">
          {section('广场预设', 'preset', presets, presetCursor)}
          {section('预设合集', 'collection', collections, collectionCursor)}
        </div>
      </div>
    </section>
  );
}

function targetPath(kind: MarketplaceLikeTargetKind, id: string): string {
  const segment = kind === 'preset' ? 'presets' : 'collections';
  return `/marketplace/${segment}/${encodeURIComponent(id)}`;
}
