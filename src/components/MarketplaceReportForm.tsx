import { useState, type FormEvent } from 'react';
import { Flag } from 'lucide-react';
import type {
  MarketplaceModerationReportReason,
  MarketplaceModerationTargetKind,
} from '../../shared/marketplace';
import { marketplaceClient, MarketplaceClientError } from '../marketplace/client';

const REASONS: Array<{ value: MarketplaceModerationReportReason; label: string }> = [
  { value: 'copyright', label: 'Copyright' },
  { value: 'spam', label: 'Spam' },
  { value: 'impersonation', label: 'Impersonation' },
  { value: 'inappropriate', label: 'Inappropriate content' },
];

const TARGET_LABEL: Record<MarketplaceModerationTargetKind, string> = {
  preset: 'tone',
  collection: 'collection',
  member: 'creator',
};

export function MarketplaceReportForm({ kind, targetId, onNavigate }: {
  kind: MarketplaceModerationTargetKind;
  targetId: string;
  onNavigate(pathname: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<MarketplaceModerationReportReason>('inappropriate');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    setVerificationUrl(null);
    setRetryAt(null);
    try {
      const receipt = await marketplaceClient.submitReport({ targetKind: kind, targetId, reason, details });
      setDetails('');
      setMessage(`Report received — reference ${receipt.id}. Moderators review reports in a private queue.`);
    } catch (cause) {
      if (cause instanceof MarketplaceClientError && cause.verificationUrl) {
        setVerificationUrl(cause.verificationUrl);
      }
      if (cause instanceof MarketplaceClientError && cause.retryAt) setRetryAt(cause.retryAt);
      setMessage(cause instanceof Error ? cause.message : 'Report submission failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="marketplace-report">
      <div className="marketplace-report__buttons">
        <button type="button" className="mk-btn mk-btn--ghost" onClick={() => setOpen((current) => !current)}>
          <Flag size={14} aria-hidden="true" />
          {open ? 'Hide report form' : `Report this ${TARGET_LABEL[kind]}`}
        </button>
        <button type="button" className="mk-btn mk-btn--ghost" onClick={() => onNavigate('/marketplace/infringement-notice')}>
          Formal infringement notice
        </button>
      </div>
      {open && (
        <form className="marketplace-report__form" onSubmit={(event) => void submit(event)}>
          <label>
            Reason
            <select className="mk-input" value={reason} onChange={(event) => setReason(
              event.target.value as MarketplaceModerationReportReason,
            )}>
              {REASONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label>
            Details
            <textarea
              className="mk-input"
              required
              maxLength={2000}
              value={details}
              onChange={(event) => setDetails(event.target.value)}
              placeholder="Give the moderators enough detail to evaluate this report."
            />
          </label>
          <button type="submit" className="mk-btn mk-btn--secondary" disabled={busy || !details.trim()}>
            {busy ? 'Submitting…' : 'Submit report'}
          </button>
        </form>
      )}
      {message && <small role="status">{message}</small>}
      {verificationUrl && (
        <button type="button" className="mk-btn mk-btn--ghost" onClick={() => onNavigate(verificationUrl)}>Verify email</button>
      )}
      {retryAt && <small>Retry available after {new Date(retryAt).toLocaleString()}</small>}
    </aside>
  );
}
