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
      setMessage('正式侵权通知已提交。');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '通知提交失败。');
    } finally {
      setBusy(false);
    }
  };

  useDocumentTitle('正式侵权通知');
  return (
    <MarketplaceModerationShell eyebrow="Formal infringement notice" title="正式侵权通知" onClose={onClose}>
      <p>此入口无需登录，与成员举报分开处理。请只提交你有权声明的作品。</p>
      <form className="marketplace-moderation__form" onSubmit={(event) => void submit(event)}>
        <label>姓名<input required maxLength={160} value={claimantName} onChange={(event) => setClaimantName(event.target.value)} /></label>
        <label>联系邮箱<input required type="email" maxLength={320} value={claimantEmail} onChange={(event) => setClaimantEmail(event.target.value)} /></label>
        <label>
          目标类型
          <select value={targetKind} onChange={(event) => setTargetKind(event.target.value as MarketplaceContentModerationTargetKind)}>
            <option value="preset">广场预设</option>
            <option value="collection">预设合集</option>
          </select>
        </label>
        <label>目标 ID<input required maxLength={200} value={targetId} onChange={(event) => setTargetId(event.target.value)} /></label>
        <label>
          权利说明
          <textarea required minLength={20} maxLength={4000} value={rightsStatement} onChange={(event) => setRightsStatement(event.target.value)} />
        </label>
        <label className="marketplace-moderation__check">
          <input type="checkbox" required checked={goodFaith} onChange={(event) => setGoodFaith(event.target.checked)} />
          我确认以上声明出于善意且信息准确。
        </label>
        <button type="submit" disabled={busy || !goodFaith}>{busy ? '提交中…' : '提交正式通知'}</button>
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
      (cause: unknown) => { if (active) setMessage(cause instanceof Error ? cause.message : '治理记录暂不可用。'); },
    );
    return () => { active = false; };
  }, [attempt]);
  useDocumentTitle('我的治理记录');

  return (
    <MarketplaceModerationShell eyebrow="My moderation cases" title="我的治理记录" onClose={onClose}>
      {message && <p className="marketplace-detail__error" role="alert">{message}</p>}
      {cases.map((item) => (
        <article className="marketplace-moderation__case" key={item.actionId}>
          <h3>{item.targetKind === 'preset' ? '广场预设' : '预设合集'}已隐藏</h3>
          <button type="button" onClick={() => onNavigate(targetPath(item.targetKind, item.targetId))}>
            {item.targetId}
          </button>
          <p>处理原因：{item.reason}</p>
          <small>{new Date(item.createdAt).toLocaleString()}</small>
          {item.appeal
            ? <p>申诉状态：{appealStatus(item.appeal.status)}</p>
            : <AppealForm actionId={item.actionId} onSubmitted={() => setAttempt((value) => value + 1)} />}
        </article>
      ))}
      {!message && cases.length === 0 && <p>目前没有与你的作品有关的治理记录。</p>}
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
      setMessage(cause instanceof Error ? cause.message : '申诉提交失败。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="marketplace-moderation__form" onSubmit={(event) => void submit(event)}>
      <label>
        申诉说明（本次处理仅可提交一次）
        <textarea required maxLength={2000} value={statement} onChange={(event) => setStatement(event.target.value)} />
      </label>
      <button type="submit" disabled={busy || !statement.trim()}>{busy ? '提交中…' : '提交申诉'}</button>
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
        <span className="marketplace-detail__eyebrow">音色广场 · {eyebrow}</span>
        <button className="marketplace-detail__close" type="button" onClick={onClose}>返回效果器</button>
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
  if (status === 'pending') return '等待管理员复核';
  return status === 'upheld' ? '申诉成立' : '维持原处理';
}
