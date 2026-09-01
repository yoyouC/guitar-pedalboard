import { useState } from 'react';
import { memberSession } from '../members/session.ts';
import { useMemberSession } from '../members/useMemberSession.ts';
import type { AppLocale } from '../app/preferences.ts';

interface MemberPanelProps {
  onNavigate(pathname: string): void;
  locale: AppLocale;
}

function currentReturnPath(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function MemberPanel({ onNavigate, locale }: MemberPanelProps) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const session = useMemberSession();

  if (session.status === 'loading') {
    return <span className="member-menu__loading" aria-label={locale === 'zh-CN' ? '正在读取成员会话' : 'Loading member session'}>…</span>;
  }

  if (session.status === 'anonymous' || session.status === 'unavailable') {
    return (
      <button
        type="button"
        className="member-menu__trigger"
        onClick={() => onNavigate(`/login?return=${encodeURIComponent(currentReturnPath())}`)}
      >
        {locale === 'zh-CN' ? '登录' : 'Sign in'}
      </button>
    );
  }

  const { member } = session;
  const logout = async () => {
    setMessage('');
    try {
      await memberSession.logout();
      setOpen(false);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Sign-out failed');
    }
  };

  return (
    <div className="member-menu">
      <button
        type="button"
        className="member-menu__trigger"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        @{member.handle}
      </button>
      {open && (
        <section className="member-panel" aria-label="Member account">
          <button className="member-panel__close" type="button" onClick={() => setOpen(false)}>×</button>
          <span className="marketplace-detail__eyebrow">Signed in</span>
          <h2>{member.displayName}</h2>
          {!member.readyForPublicAttribution && (
            <p className="member-panel__notice">{locale === 'zh-CN' ? '首次发布前，请完成公开署名资料和当前条款确认。' : 'Complete your public attribution profile and current terms before publishing.'}</p>
          )}
          <div className="member-panel__actions">
            <button type="button" onClick={() => {
              onNavigate('/library');
              setOpen(false);
            }}>My Library</button>
            <button type="button" onClick={() => {
              onNavigate('/settings?section=account');
              setOpen(false);
            }}>{locale === 'zh-CN' ? '设置' : 'Settings'}</button>
            <button type="button" onClick={() => {
              onNavigate(`/creators/${encodeURIComponent(member.handle)}`);
              setOpen(false);
            }}>{locale === 'zh-CN' ? '公开主页' : 'Public profile'}</button>
            <button type="button" onClick={() => void logout()}>{locale === 'zh-CN' ? '退出' : 'Sign out'}</button>
          </div>
          {message && <p className="member-panel__message" role="alert">{message}</p>}
        </section>
      )}
    </div>
  );
}
