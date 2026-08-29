import { useEffect, useState } from 'react';
import type { PresetCollection } from '../../shared/marketplace';
import { marketplaceClient } from '../marketplace/client';
import { presetCollectionIdFromPath } from '../marketplace/route';
import { PresetCollectionManager } from './PresetCollectionManager';

interface PresetCollectionRouteProps {
  pathname: string;
  onClose(): void;
  onNavigate(pathname: string): void;
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; collection: PresetCollection; managed: boolean }
  | { status: 'error'; message: string };

export function PresetCollectionRoute({ pathname, onClose, onNavigate }: PresetCollectionRouteProps) {
  const collectionId = presetCollectionIdFromPath(pathname);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: 'idle' });

  useEffect(() => {
    if (!collectionId) return;
    let active = true;
    setState({ status: 'loading' });
    void Promise.allSettled([
      marketplaceClient.getPresetCollection(collectionId),
      marketplaceClient.getManagedPresetCollection(collectionId),
    ]).then(([visible, managed]) => {
      if (!active) return;
      if (managed.status === 'fulfilled') {
        setState({ status: 'ready', collection: managed.value, managed: true });
      } else if (visible.status === 'fulfilled') {
        setState({ status: 'ready', collection: visible.value, managed: false });
      } else {
        const cause = visible.reason;
        setState({
          status: 'error',
          message: cause instanceof Error ? cause.message : '预设合集暂时不可用。',
        });
      }
    });
    return () => { active = false; };
  }, [collectionId, attempt]);

  useEffect(() => {
    if (!collectionId || state.status !== 'ready') return;
    const previousTitle = document.title;
    document.title = `${state.collection.title} · Guitar Pedalboard`;
    let robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const previousRobots = robots?.content ?? null;
    if (state.collection.visibility !== 'public') {
      if (!robots) {
        robots = document.createElement('meta');
        robots.name = 'robots';
        document.head.append(robots);
      }
      robots.content = 'noindex,nofollow';
    }
    return () => {
      document.title = previousTitle;
      if (previousRobots === null) robots?.remove();
      else if (robots) robots.content = previousRobots;
    };
  }, [collectionId, state]);

  if (!collectionId) return null;
  return (
    <section className="marketplace-detail" aria-live="polite">
      <div className="marketplace-detail__topline">
        <span className="marketplace-detail__eyebrow">音色广场 · Preset Collection</span>
        <button className="marketplace-detail__close" type="button" onClick={onClose}>返回效果器</button>
      </div>
      {state.status === 'idle' || state.status === 'loading' ? (
        <p>正在读取合集…</p>
      ) : state.status === 'error' ? (
        <div className="marketplace-detail__error" role="alert">
          <strong>未能打开这个合集</strong>
          <p>{state.message}</p>
          <button type="button" onClick={() => setAttempt((current) => current + 1)}>重试</button>
        </div>
      ) : (
        <div className="marketplace-detail__content">
          <h2>{state.collection.title}</h2>
          <p>{state.collection.description || '作者没有填写介绍。'}</p>
          <p className="marketplace-detail__byline">@{state.collection.creator.handle}</p>
          <p className="marketplace-detail__tags">
            {state.collection.tags.map((tag) => tag.nameZh).join(' · ')}
          </p>
          {state.collection.visibility !== 'public' && (
            <p className="marketplace-detail__warning">
              {state.collection.visibility === 'unlisted'
                ? 'Unlisted：仅持有直接链接的人可访问。'
                : '合集已撤回，只有作者可管理。'}
            </p>
          )}
          <ol className="collection-detail__items">
            {state.collection.items.map((item) => (
              <li key={`${item.position}-${item.presetId}-${item.revisionId}`}>
                <span className="collection-detail__position">{item.position + 1}</span>
                <div>
                  {item.availability === 'available' ? (
                    <button type="button" onClick={() => onNavigate(
                      `/marketplace/tones/${encodeURIComponent(item.presetId)}`
                      + `/revisions/${encodeURIComponent(item.revisionId)}`
                    )}>{item.title}</button>
                  ) : <strong>原作当前不可用</strong>}
                  <small>@{item.creator.handle} · revision {item.revisionId}</small>
                </div>
              </li>
            ))}
          </ol>
          {state.collection.items.length === 0 && <p>这个合集还没有条目。</p>}
          {state.managed && (
            <PresetCollectionManager
              collection={state.collection}
              onUpdated={(collection) => setState({ status: 'ready', collection, managed: true })}
            />
          )}
        </div>
      )}
    </section>
  );
}
