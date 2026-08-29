import { useEffect, useRef, useState } from 'react';
import type { MarketplaceLikeState, MarketplaceLikeTargetKind } from '../../shared/marketplace';
import { marketplaceClient, MarketplaceClientError } from '../marketplace/client';
import {
  clearPendingMarketplaceLike,
  readPendingMarketplaceLike,
  rememberPendingMarketplaceLike,
} from '../marketplace/likeIntent.ts';
import { useMemberSession } from '../members/useMemberSession.ts';

export function MarketplaceLikeButton({ kind, targetId, targetCreatorId, onNavigate, onChange }: {
  kind: MarketplaceLikeTargetKind;
  targetId: string;
  targetCreatorId: string;
  onNavigate(pathname: string): void;
  onChange?(state: MarketplaceLikeState): void;
}) {
  const session = useMemberSession();
  const [state, setState] = useState<MarketplaceLikeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<string | null>(null);
  const resuming = useRef(false);

  useEffect(() => {
    let active = true;
    resuming.current = false;
    setState(null);
    setMessage('');
    setVerificationUrl(null);
    setRetryAt(null);
    void marketplaceClient.getLikeState(kind, targetId).then(
      (next) => { if (active) setState(next); },
      () => { if (active) setMessage('点赞状态暂不可用'); },
    );
    return () => { active = false; };
  }, [kind, targetId]);

  useEffect(() => {
    if (session.status !== 'authenticated' || !state || state.liked || resuming.current) return;
    const pending = readPendingMarketplaceLike(window.sessionStorage);
    if (!pending || pending.kind !== kind || pending.targetId !== targetId) return;
    if (!state.canLike) {
      clearPendingMarketplaceLike(window.sessionStorage);
      setMessage(session.member.id === targetCreatorId
        ? '不能 Like 自己的内容。'
        : '当前账号无法 Like 此内容。');
      return;
    }
    resuming.current = true;
    setBusy(true);
    void marketplaceClient.setLike(kind, targetId, true).then((next) => {
      clearPendingMarketplaceLike(window.sessionStorage);
      setState(next);
      onChange?.(next);
      setMessage('登录成功，已完成 Like。');
    }, (cause: unknown) => {
      if (cause instanceof MarketplaceClientError && cause.verificationUrl) {
        rememberPendingMarketplaceLike(window.sessionStorage, { kind, targetId });
        setVerificationUrl(cause.verificationUrl);
      }
      if (cause instanceof MarketplaceClientError && cause.retryAt) setRetryAt(cause.retryAt);
      setMessage(cause instanceof Error ? cause.message : '登录后 Like 失败，请重试。');
    }).finally(() => setBusy(false));
  }, [kind, onChange, session, state, targetCreatorId, targetId]);

  const toggle = async () => {
    if (session.status === 'anonymous') {
      rememberPendingMarketplaceLike(window.sessionStorage, { kind, targetId });
      const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      onNavigate(`/login?return=${encodeURIComponent(returnTo)}`);
      return;
    }
    if (!state?.canLike) return;
    setBusy(true);
    setMessage('');
    setVerificationUrl(null);
    setRetryAt(null);
    try {
      const next = await marketplaceClient.setLike(kind, targetId, !state.liked);
      setState(next);
      onChange?.(next);
    } catch (cause) {
      if (cause instanceof MarketplaceClientError && cause.verificationUrl) {
        rememberPendingMarketplaceLike(window.sessionStorage, { kind, targetId });
        setVerificationUrl(cause.verificationUrl);
      }
      if (cause instanceof MarketplaceClientError && cause.retryAt) setRetryAt(cause.retryAt);
      setMessage(cause instanceof Error ? cause.message : '点赞失败');
    } finally {
      setBusy(false);
    }
  };

  const ownContent = session.status === 'authenticated' && session.member.id === targetCreatorId;
  const canStartLogin = session.status === 'anonymous';

  return (
    <div className="marketplace-like">
      <button
        type="button"
        disabled={busy || ownContent || (!canStartLogin && !state?.canLike)}
        onClick={() => void toggle()}
      >
        {state?.liked ? '♥ 已点赞' : '♡ 点赞'} · {state?.likeCount ?? '—'}
      </button>
      {ownContent && <small>不能 Like 自己的内容</small>}
      {!ownContent && session.status === 'anonymous' && <small>登录后将自动完成 Like</small>}
      {!ownContent && session.status === 'authenticated' && state && !state.canLike && <small>当前账号无法 Like 此内容</small>}
      {message && <small role="alert">{message}</small>}
      {verificationUrl && <button type="button" onClick={() => onNavigate(verificationUrl)}>验证邮箱</button>}
      {retryAt && <small>可重试时间：{new Date(retryAt).toLocaleString()}</small>}
    </div>
  );
}
