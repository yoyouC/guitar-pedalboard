import { useEffect, useState, type FormEvent } from 'react';
import type { MemberProfile } from '../../shared/members.ts';
import {
  beginGoogleAuth,
  fetchCurrentMember,
  MemberClientError,
  requestMagicLink,
  signOut,
  updateMemberProfile,
} from '../members/client.ts';
import { CreatePresetCollectionForm } from './CreatePresetCollectionForm.tsx';

interface MemberPanelProps {
  onNavigate(pathname: string): void;
}

export function MemberPanel({ onNavigate }: MemberPanelProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [member, setMember] = useState<MemberProfile | null>(null);
  const [anonymous, setAnonymous] = useState(false);
  const [email, setEmail] = useState('');
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [message, setMessage] = useState('');
  const [creatingCollection, setCreatingCollection] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setMessage('');
    void fetchCurrentMember()
      .then((next) => {
        setMember(next);
        setAnonymous(false);
        setHandle(next.handle);
        setDisplayName(next.displayName);
        setBio(next.bio);
      })
      .catch((cause: unknown) => {
        if (cause instanceof MemberClientError && cause.code === 'authentication_required') {
          setAnonymous(true);
          setMember(null);
          return;
        }
        setMessage(cause instanceof Error ? cause.message : '成员服务暂时不可用');
      })
      .finally(() => setLoading(false));
  }, [open]);

  const sendMagicLink = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      await requestMagicLink(email, `${window.location.pathname}${window.location.hash}`);
      setMessage('登录链接已发送，请检查邮箱。链接 5 分钟内有效。');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '发送失败');
    } finally {
      setLoading(false);
    }
  };

  const google = async (mode: 'sign-in' | 'link') => {
    setLoading(true);
    setMessage('');
    try {
      const url = await beginGoogleAuth(mode, `${window.location.pathname}${window.location.hash}`);
      window.location.assign(url);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Google 认证不可用');
      setLoading(false);
    }
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      if (!member) return;
      const next = await updateMemberProfile({
        handle,
        displayName,
        bio,
        expectedUpdatedAt: member.updatedAt,
      });
      setMember(next);
      setMessage('资料已保存。');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    setLoading(true);
    try {
      await signOut();
      setMember(null);
      setAnonymous(true);
      setMessage('已退出登录。');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '退出失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="member-menu">
      <button type="button" className="member-menu__trigger" onClick={() => setOpen((value) => !value)}>
        {member ? `@${member.handle}` : '登录 / 创作者'}
      </button>
      {open && (
        <section className="member-panel" aria-label="成员账户">
          <button className="member-panel__close" type="button" onClick={() => setOpen(false)}>×</button>
          <h2>{member ? '创作者资料' : '登录 Guitar Pedalboard'}</h2>
          {loading && <p>处理中…</p>}
          {anonymous && !loading && (
            <>
              <form onSubmit={sendMagicLink}>
                <label>
                  邮箱
                  <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
                </label>
                <button type="submit">发送魔法链接</button>
              </form>
              <button type="button" onClick={() => void google('sign-in')}>使用 Google 登录</button>
              <small>本站不保存密码；相同邮箱不会自动合并身份。</small>
            </>
          )}
          {member && !loading && (
            <>
              {creatingCollection ? (
                <CreatePresetCollectionForm
                  onCancel={() => setCreatingCollection(false)}
                  onCreated={(pathname) => {
                    onNavigate(pathname);
                    setCreatingCollection(false);
                    setOpen(false);
                  }}
                />
              ) : (
              <form onSubmit={saveProfile}>
                <label>
                  Handle
                  <input required pattern="[a-z0-9][a-z0-9-]{1,28}[a-z0-9]" value={handle} onChange={(event) => setHandle(event.target.value)} />
                </label>
                <small>修改后 90 天内不能再次修改；旧 handle 会永久跳转。</small>
                <label>
                  显示名
                  <input required maxLength={80} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
                </label>
                <label>
                  简介
                  <textarea maxLength={500} value={bio} onChange={(event) => setBio(event.target.value)} />
                </label>
                <button type="submit">保存资料</button>
              </form>
              )}
              <div className="member-panel__actions">
                {!creatingCollection && (
                  <button type="button" onClick={() => setCreatingCollection(true)}>
                    创建预设合集
                  </button>
                )}
                <button type="button" onClick={() => {
                  onNavigate(`/creators/${encodeURIComponent(member.handle)}`);
                  setOpen(false);
                }}>查看公开主页</button>
                <button type="button" onClick={() => void google('link')}>验证并绑定 Google</button>
                <button type="button" onClick={() => void logout()}>退出</button>
              </div>
            </>
          )}
          {message && <p className="member-panel__message">{message}</p>}
        </section>
      )}
    </div>
  );
}
