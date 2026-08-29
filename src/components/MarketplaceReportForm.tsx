import { useState, type FormEvent } from 'react';
import type {
  MarketplaceModerationReportReason,
  MarketplaceModerationTargetKind,
} from '../../shared/marketplace';
import { marketplaceClient } from '../marketplace/client';

const REASONS: Array<{ value: MarketplaceModerationReportReason; label: string }> = [
  { value: 'copyright', label: '侵权' },
  { value: 'spam', label: '垃圾内容' },
  { value: 'impersonation', label: '冒充' },
  { value: 'inappropriate', label: '不当内容' },
];

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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await marketplaceClient.submitReport({ targetKind: kind, targetId, reason, details });
      setDetails('');
      setMessage('举报已提交，管理员会在私有队列中处理。');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '举报提交失败。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="marketplace-report">
      <div className="marketplace-report__buttons">
        <button type="button" onClick={() => setOpen((current) => !current)}>
          {open ? '收起举报' : '举报内容'}
        </button>
        <button type="button" onClick={() => onNavigate('/marketplace/infringement-notice')}>
          正式侵权通知
        </button>
      </div>
      {open && (
        <form onSubmit={(event) => void submit(event)}>
          <label>
            原因
            <select value={reason} onChange={(event) => setReason(
              event.target.value as MarketplaceModerationReportReason,
            )}>
              {REASONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label>
            说明
            <textarea
              required
              maxLength={2000}
              value={details}
              onChange={(event) => setDetails(event.target.value)}
              placeholder="请提供足够的信息，帮助管理员判断。"
            />
          </label>
          <button type="submit" disabled={busy || !details.trim()}>
            {busy ? '提交中…' : '提交举报'}
          </button>
        </form>
      )}
      {message && <small role="status">{message}</small>}
    </aside>
  );
}
