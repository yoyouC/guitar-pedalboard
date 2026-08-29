import { useEffect, useState } from 'react';
import type { PublicCreatorProfile, PublicCreatorWorkSummary } from '../../shared/members.ts';
import { fetchPublicCreator, fetchPublicCreatorWorks } from '../members/client.ts';
import { loadCreatorProfile } from '../members/loadCreatorProfile.ts';
import { creatorHandleFromPath } from '../marketplace/route.ts';

interface CreatorProfileRouteProps {
  pathname: string;
  onClose(): void;
  onNavigate(pathname: string): void;
}

export function CreatorProfileRoute({ pathname, onClose, onNavigate }: CreatorProfileRouteProps) {
  const handle = creatorHandleFromPath(pathname);
  const [creator, setCreator] = useState<PublicCreatorProfile | null>(null);
  const [error, setError] = useState('');
  const [works, setWorks] = useState<PublicCreatorWorkSummary[]>([]);

  useEffect(() => {
    setCreator(null);
    setError('');
    setWorks([]);
    if (!handle) return;
    return loadCreatorProfile(handle, {
      fetchCreator: fetchPublicCreator,
      fetchWorks: fetchPublicCreatorWorks,
      onLoaded(nextCreator, nextWorks) {
        setCreator(nextCreator);
        setWorks(nextWorks);
        if (nextCreator.handle !== handle) {
          onNavigate(`/creators/${encodeURIComponent(nextCreator.handle)}`);
        }
      },
      onError(cause) {
        setError(cause instanceof Error ? cause.message : '无法加载创作者');
      },
    });
  }, [handle, onNavigate]);

  if (!handle) return null;
  return (
    <section className="creator-profile" aria-label="公开创作者主页">
      <button type="button" className="marketplace-detail__close" onClick={onClose}>返回效果器</button>
      {!creator && !error && <p>正在加载创作者资料…</p>}
      {error && <p className="marketplace-detail__error">{error}</p>}
      {creator && (
        <>
          {creator.avatarUrl && <img src={creator.avatarUrl} alt="" referrerPolicy="no-referrer" />}
          <div>
            <span className="marketplace-detail__eyebrow">公开创作者主页</span>
            <h2>{creator.displayName}</h2>
            <p>@{creator.handle}</p>
            {creator.bio && <p>{creator.bio}</p>}
            <h3>公开作品</h3>
            {works.length === 0 && <small>尚无公开作品。</small>}
            {works.map((work) => (
              <button type="button" key={work.id} onClick={() => onNavigate(work.url)}>
                {work.title}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
