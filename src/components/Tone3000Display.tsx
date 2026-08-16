import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Tone3000UserInfo, ToneInfo } from '../tone3000/client';
import {
  getTone3000Authenticated,
  subscribeTone3000Auth,
  tone3000,
} from '../tone3000/instance';

export function Tone3000Account({ actions }: { actions?: ReactNode }) {
  const authenticated = useSyncExternalStore(
    subscribeTone3000Auth,
    getTone3000Authenticated,
  );
  const [user, setUser] = useState<Tone3000UserInfo | null>(null);

  useEffect(() => {
    if (!authenticated) {
      setUser(null);
      return;
    }
    let cancelled = false;
    void tone3000
      .getCurrentUser()
      .then((next) => {
        if (!cancelled) setUser(next);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      });
    return () => {
      cancelled = true;
    };
  }, [authenticated]);

  return (
    <div className="tone3000-account">
      {authenticated ? (
        user ? (
          <a href={user.url} target="_blank" rel="noreferrer" className="tone3000-account-user">
            {user.avatarUrl && <img src={user.avatarUrl} alt="" />}
            <span>@{user.username}</span>
          </a>
        ) : (
          <span className="tone3000-byline">TONE3000 已登录</span>
        )
      ) : (
        <span className="tone3000-byline">TONE3000 未登录</span>
      )}
      {actions}
    </div>
  );
}

export function Tone3000ModelAttribution({
  info,
  fallback,
}: {
  info?: ToneInfo | null;
  fallback: string;
}) {
  return (
    <div className="tone3000-model-attribution">
      {info?.imageUrl && <img src={info.imageUrl} alt="" className="tone3000-model-image" />}
      <div className="tone3000-model-copy">
        <span className="tone3000-title">{info?.title ?? fallback}</span>
        {info && (
          <span className="tone3000-byline tone3000-creator">
            {info.avatarUrl && <img src={info.avatarUrl} alt="" />}
            {info.gear ?? '未知 gear'} · {(info.format ?? 'NAM').toUpperCase()} · @{info.username} ·{' '}
            {info.license.toUpperCase()}
          </span>
        )}
        {info?.url && (
          <a href={info.url} target="_blank" rel="noreferrer">
            在 TONE3000 查看
          </a>
        )}
      </div>
      <span className="tone3000-mark">Powered by TONE3000</span>
    </div>
  );
}
