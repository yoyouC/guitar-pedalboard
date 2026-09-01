import { useEffect, useRef, useState } from 'react';
import { Heart } from 'lucide-react';
import type { MarketplaceLikeState, MarketplaceLikeTargetKind } from '../../shared/marketplace';
import { marketplaceClient, MarketplaceClientError } from '../marketplace/client';
import {
  clearPendingMarketplaceLike,
  readPendingMarketplaceLike,
  rememberPendingMarketplaceLike,
} from '../marketplace/likeIntent.ts';
import { useMemberSession } from '../members/useMemberSession.ts';

export function MarketplaceLikeButton({ kind, targetId, targetCreatorId, onNavigate, onChange, hideHints = false }: {
  kind: MarketplaceLikeTargetKind;
  targetId: string;
  targetCreatorId: string;
  onNavigate(pathname: string): void;
  onChange?(state: MarketplaceLikeState): void;
  /** Suppresses the hint/status paragraphs (list-row contexts); button, count, and logic stay. */
  hideHints?: boolean;
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
      () => { if (active) setMessage('Like status is unavailable.'); },
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
        ? 'You can\'t like your own content.'
        : 'This account can\'t like this content.');
      return;
    }
    resuming.current = true;
    setBusy(true);
    void marketplaceClient.setLike(kind, targetId, true).then((next) => {
      clearPendingMarketplaceLike(window.sessionStorage);
      setState(next);
      onChange?.(next);
      setMessage('Signed in — like completed.');
    }, (cause: unknown) => {
      if (cause instanceof MarketplaceClientError && cause.verificationUrl) {
        rememberPendingMarketplaceLike(window.sessionStorage, { kind, targetId });
        setVerificationUrl(cause.verificationUrl);
      }
      if (cause instanceof MarketplaceClientError && cause.retryAt) setRetryAt(cause.retryAt);
      setMessage(cause instanceof Error ? cause.message : 'Like after sign-in failed — please retry.');
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
      setMessage(cause instanceof Error ? cause.message : 'Like failed');
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
        className="mk-btn mk-btn--secondary mk-like-btn"
        disabled={busy || ownContent || (!canStartLogin && !state?.canLike)}
        onClick={() => void toggle()}
      >
        <Heart size={14} aria-hidden="true" fill={state?.liked ? 'currentColor' : 'none'} />
        {state?.liked ? 'Liked' : 'Like'} · {state?.likeCount ?? '—'}
      </button>
      {ownContent && !hideHints && <small>You can&apos;t like your own content</small>}
      {!ownContent && !hideHints && session.status === 'anonymous' && <small>Sign in and the like completes automatically</small>}
      {!ownContent && !hideHints && session.status === 'authenticated' && state && !state.canLike && <small>This account can&apos;t like this content</small>}
      {message && !hideHints && <small role="alert">{message}</small>}
      {verificationUrl && <button type="button" className="mk-btn mk-btn--ghost" onClick={() => onNavigate(verificationUrl)}>Verify email</button>}
      {retryAt && !hideHints && <small>Retry available after {new Date(retryAt).toLocaleString()}</small>}
    </div>
  );
}
