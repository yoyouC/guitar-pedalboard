import { useEffect, useState, type FormEvent } from 'react';
import { beginGoogleAuth, requestMagicLink } from '../members/client.ts';
import { useMemberSession } from '../members/useMemberSession.ts';
import { loginReturnFromSearch } from '../app/loginReturn.ts';
import type { AppLocale } from '../app/preferences.ts';

interface LoginPageProps {
  search: string;
  locale: AppLocale;
  onNavigate(pathname: string): void;
}

export function LoginPage({ search, locale, onNavigate }: LoginPageProps) {
  const session = useMemberSession();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const returnTo = loginReturnFromSearch(search);

  useEffect(() => {
    if (session.status === 'authenticated') onNavigate(returnTo);
  }, [onNavigate, returnTo, session.status]);

  const magicLink = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await requestMagicLink(email, returnTo);
      setMessage(locale === 'zh-CN' ? '登录链接已发送，请在 5 分钟内查看邮箱。' : 'Sign-in link sent. Check your email within five minutes.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '登录服务暂时不可用');
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    setBusy(true);
    setMessage('');
    try {
      window.location.assign(await beginGoogleAuth('sign-in', returnTo));
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Google 登录暂时不可用');
      setBusy(false);
    }
  };

  return (
    <section className="login-page">
      <div className="login-page__intro">
        <span className="marketplace-detail__eyebrow">Guitar Pedalboard account</span>
        <h1>{locale === 'zh-CN' ? '登录后保存你的线上 Tone 关系' : 'Sign in for your online Tone relationships'}</h1>
        <p>{locale === 'zh-CN' ? '浏览 Tone Market 和使用本地效果器无需登录。登录只用于 Like、发布、合集和成员资料。' : 'Browsing Tone Market and using the local Pedalboard stay anonymous. Sign-in is for Likes, publishing, collections and membership.'}</p>
        <aside>
          <strong>{locale === 'zh-CN' ? '本站账号 ≠ TONE3000 授权' : 'Site account ≠ TONE3000 authorization'}</strong>
          <p>{locale === 'zh-CN' ? '本站登录管理社区身份；TONE3000 只在你选择托管模型时单独请求授权，两者不会自动绑定。' : 'This account owns community identity. TONE3000 asks separately when you choose a hosted model; the identities are not auto-linked.'}</p>
        </aside>
      </div>
      <div className="login-page__card">
        <h2>{locale === 'zh-CN' ? '继续使用' : 'Continue'}</h2>
        <form onSubmit={(event) => void magicLink(event)}>
          <label>
            {locale === 'zh-CN' ? '邮箱' : 'Email'}
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy}>{locale === 'zh-CN' ? '发送 Magic Link' : 'Send Magic Link'}</button>
        </form>
        <div className="login-page__separator"><span>{locale === 'zh-CN' ? '或' : 'or'}</span></div>
        <button type="button" disabled={busy} onClick={() => void google()}>
          {locale === 'zh-CN' ? '使用 Google 登录' : 'Continue with Google'}
        </button>
        <small>{locale === 'zh-CN' ? '本站不保存密码；同邮箱身份不会被静默合并。' : 'No password is stored here, and same-email identities are never silently merged.'}</small>
        {session.status === 'unavailable' && <p role="alert">{session.message}</p>}
        {message && <p role="status">{message}</p>}
      </div>
    </section>
  );
}
