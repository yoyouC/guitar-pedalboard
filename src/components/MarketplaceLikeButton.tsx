import { useEffect, useState } from 'react';
import type { MarketplaceLikeState, MarketplaceLikeTargetKind } from '../../shared/marketplace';
import { marketplaceClient } from '../marketplace/client';

export function MarketplaceLikeButton({ kind, targetId }: {
  kind: MarketplaceLikeTargetKind;
  targetId: string;
}) {
  const [state, setState] = useState<MarketplaceLikeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    setState(null);
    void marketplaceClient.getLikeState(kind, targetId).then(
      (next) => { if (active) setState(next); },
      () => { if (active) setMessage('点赞状态暂不可用'); },
    );
    return () => { active = false; };
  }, [kind, targetId]);

  const toggle = async () => {
    if (!state?.canLike) return;
    setBusy(true);
    setMessage('');
    try {
      setState(await marketplaceClient.setLike(kind, targetId, !state.liked));
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '点赞失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="marketplace-like">
      <button type="button" disabled={busy || !state?.canLike} onClick={() => void toggle()}>
        {state?.liked ? '♥ 已点赞' : '♡ 点赞'} · {state?.likeCount ?? '—'}
      </button>
      {state && !state.canLike && <small>登录后可点赞他人的作品</small>}
      {message && <small role="alert">{message}</small>}
    </div>
  );
}
