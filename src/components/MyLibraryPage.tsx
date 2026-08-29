import { useEffect, useState } from 'react';
import type { PublishedPreset } from '../../shared/marketplace';
import { marketplaceClient } from '../marketplace/client';
import { useMemberSession } from '../members/useMemberSession';

interface Props { onNavigate(pathname: string): void }

export function MyLibraryPage({ onNavigate }: Props) {
  const session = useMemberSession();
  const [tones, setTones] = useState<PublishedPreset[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (session.status !== 'authenticated') return;
    let active = true;
    void marketplaceClient.listManagedPublishedPresets().then((items) => {
      if (active) { setTones(items); setStatus('ready'); }
    }, (cause: unknown) => {
      if (active) { setMessage(cause instanceof Error ? cause.message : 'My Tones 暂时不可用。'); setStatus('error'); }
    });
    return () => { active = false; };
  }, [session.status]);
  if (session.status === 'loading') return <section className="library-page"><p>Loading My Library…</p></section>;
  if (session.status !== 'authenticated') return <section className="library-page app-route-placeholder"><h1>My Library</h1><p>登录后管理你的线上关系；浏览器 Local Preset 不会上传或出现在这里。</p><button type="button" onClick={() => onNavigate('/login?return=%2Flibrary')}>Sign in</button></section>;
  return (
    <section className="library-page">
      <span className="marketplace-detail__eyebrow">Private member workspace</span><h1>My Library</h1>
      <nav className="library-page__tabs" aria-label="Library sections"><button type="button" disabled>My Likes · coming next</button><button type="button" disabled>My Collections · coming next</button><button type="button" aria-current="page">My Tones</button></nav>
      <p><strong>My Tones</strong> 包含你拥有的 Public、Unlisted 和 Withdrawn 作品。Local Preset 只属于当前浏览器，不在此同步。</p>
      {status === 'loading' && <p>正在读取 My Tones…</p>}
      {status === 'error' && <p role="alert">{message}</p>}
      {status === 'ready' && tones.length === 0 && <div className="marketplace-search__empty"><strong>还没有线上 Tone</strong><p>从当前 Pedalboard Rig 开始创作。</p><button type="button" onClick={() => onNavigate('/')}>Open Pedalboard to Create</button></div>}
      <div className="library-page__tones">{tones.map((tone) => <article key={tone.id}><div><h2>{tone.title}</h2><span className={`library-page__visibility ${tone.visibility}`}>{tone.visibility}</span></div><p>{tone.description || '没有介绍。'}</p><small>revision {tone.currentRevision.id} · updated {new Date(tone.updatedAt).toLocaleString()}</small><div><button type="button" onClick={() => onNavigate(`/marketplace/tones/${encodeURIComponent(tone.id)}`)}>View</button><button type="button" onClick={() => onNavigate(`/library/tones/${encodeURIComponent(tone.id)}`)}>Manage</button></div></article>)}</div>
    </section>
  );
}
