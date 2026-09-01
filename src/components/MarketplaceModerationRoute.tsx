import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type {
  MarketplaceAuthorModerationCase,
  MarketplaceContentModerationTargetKind,
  MarketplaceModerationTargetKind,
} from '../../shared/marketplace';
import { marketplaceClient } from '../marketplace/client';

const NOTICE_PATH = '/marketplace/infringement-notice';
const CASES_PATH = '/marketplace/me/moderation';

export function MarketplaceModerationRoute({ pathname, onClose, onNavigate }: {
  pathname: string;
  onClose(): void;
  onNavigate(pathname: string): void;
}) {
  const normalized = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (normalized === NOTICE_PATH) {
    return <InfringementNoticeRoute onClose={onClose} />;
  }
  if (normalized === CASES_PATH) {
    return <AuthorCasesRoute onClose={onClose} onNavigate={onNavigate} />;
  }
  return null;
}

function InfringementNoticeRoute({ onClose }: { onClose(): void }) {
  const params = new URLSearchParams(window.location.search);
  const initialKind = params.get('targetKind') === 'collection' ? 'collection' : 'preset';
  const [claimantName, setClaimantName] = useState('');
  const [claimantEmail, setClaimantEmail] = useState('');
  const [targetKind, setTargetKind] = useState<MarketplaceContentModerationTargetKind>(initialKind);
  const [targetId, setTargetId] = useState(params.get('targetId') ?? '');
  const [rightsStatement, setRightsStatement] = useState('');
  const [goodFaith, setGoodFaith] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await marketplaceClient.submitInfringementNotice({
        claimantName, claimantEmail, targetKind, targetId,
        rightsStatement, goodFaith: true,
      });
      setMessage('Formal infringement notice submitted.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Notice submission failed.');
    } finally {
      setBusy(false);
    }
  };

  useDocumentTitle('Formal infringement notice');
  return (
    <MarketplaceModerationShell eyebrow="Formal infringement notice" title="Formal infringement notice" onClose={onClose}>
      <p>This entry requires no sign-in and is handled separately from member reports. Only submit works you are entitled to claim.</p>
      <form className="marketplace-moderation__form" onSubmit={(event) => void submit(event)}>
        <label>Name<input required maxLength={160} value={claimantName} onChange={(event) => setClaimantName(event.target.value)} /></label>
        <label>Contact email<input required type="email" maxLength={320} value={claimantEmail} onChange={(event) => setClaimantEmail(event.target.value)} /></label>
        <label>
          Target type
          <select value={targetKind} onChange={(event) => setTargetKind(event.target.value as MarketplaceContentModerationTargetKind)}>
            <option value="preset">Marketplace tone</option>
            <option value="collection">Preset collection</option>
          </select>
        </label>
        <label>Target ID<input required maxLength={200} value={targetId} onChange={(event) => setTargetId(event.target.value)} /></label>
        <label>
          Rights statement
          <textarea required minLength={20} maxLength={4000} value={rightsStatement} onChange={(event) => setRightsStatement(event.target.value)} />
        </label>
        <label className="marketplace-moderation__check">
          <input type="checkbox" required checked={goodFaith} onChange={(event) => setGoodFaith(event.target.checked)} />
          I confirm these statements are made in good faith and are accurate.
        </label>
        <button type="submit" disabled={busy || !goodFaith}>{busy ? 'Submitting…' : 'Submit formal notice'}</button>
      </form>
      {message && <p role="status">{message}</p>}
    </MarketplaceModerationShell>
  );
}

function AuthorCasesRoute({ onClose, onNavigate }: {
  onClose(): void;
  onNavigate(pathname: string): void;
}) {
  const [cases, setCases] = useState<MarketplaceAuthorModerationCase[]>([]);
  const [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setMessage('');
    void marketplaceClient.getMyModerationCases().then(
      (items) => { if (active) setCases(items); },
      (cause: unknown) => { if (active) setMessage(cause instanceof Error ? cause.message : 'Moderation cases are unavailable.'); },
    );
    return () => { active = false; };
  }, [attempt]);
  useDocumentTitle('My moderation cases');

  return (
    <MarketplaceModerationShell eyebrow="My moderation cases" title="My moderation cases" onClose={onClose}>
      {message && <p className="marketplace-detail__error" role="alert">{message}</p>}
      {cases.map((item) => (
        <article className="marketplace-moderation__case" key={item.actionId}>
          <h3>{item.targetKind === 'preset' ? 'Marketplace tone' : 'Preset collection'} hidden</h3>
          <button type="button" onClick={() => onNavigate(targetPath(item.targetKind, item.targetId))}>
            {item.targetId}
          </button>
          <p>Reason: {item.reason}</p>
          <small>{new Date(item.createdAt).toLocaleString()}</small>
          {item.appeal
            ? <p>Appeal status: {appealStatus(item.appeal.status)}</p>
            : <AppealForm actionId={item.actionId} onSubmitted={() => setAttempt((value) => value + 1)} />}
        </article>
      ))}
      {!message && cases.length === 0 && <p>No moderation cases involve your work.</p>}
    </MarketplaceModerationShell>
  );
}

function AppealForm({ actionId, onSubmitted }: { actionId: string; onSubmitted(): void }) {
  const [statement, setStatement] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await marketplaceClient.submitModerationAppeal(actionId, statement);
      onSubmitted();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Appeal submission failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="marketplace-moderation__form" onSubmit={(event) => void submit(event)}>
      <label>
        Appeal statement (only one appeal per action)
        <textarea required maxLength={2000} value={statement} onChange={(event) => setStatement(event.target.value)} />
      </label>
      <button type="submit" disabled={busy || !statement.trim()}>{busy ? 'Submitting…' : 'Submit appeal'}</button>
      {message && <small role="alert">{message}</small>}
    </form>
  );
}

function MarketplaceModerationShell({ eyebrow, title, onClose, children }: {
  eyebrow: string;
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  return (
    <section className="marketplace-detail" aria-live="polite">
      <div className="marketplace-detail__topline">
        <span className="marketplace-detail__eyebrow">Tone Market · {eyebrow}</span>
        <button className="marketplace-detail__close" type="button" onClick={onClose}>Back to pedalboard</button>
      </div>
      <div className="marketplace-detail__content">
        <h2>{title}</h2>
        {children}
      </div>
    </section>
  );
}

function useDocumentTitle(title: string) {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} · Guitar Pedalboard`;
    return () => { document.title = previous; };
  }, [title]);
}

function targetPath(kind: MarketplaceModerationTargetKind, id: string): string {
  return `/marketplace/${kind === 'preset' ? 'presets' : 'collections'}/${encodeURIComponent(id)}`;
}

function appealStatus(status: NonNullable<MarketplaceAuthorModerationCase['appeal']>['status']): string {
  if (status === 'pending') return 'Pending moderator review';
  return status === 'upheld' ? 'Appeal upheld' : 'Original action stands';
}
