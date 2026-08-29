import { useEffect, useState } from 'react';
import type { PresetCollection, PublishedPreset } from '../../shared/marketplace';
import { marketplaceClient } from '../marketplace/client';
import { useMemberSession } from '../members/useMemberSession';
import { CreatePresetCollectionForm } from './CreatePresetCollectionForm';
import { MarketplaceMyLikesPanel } from './MarketplaceLikesRoute.tsx';

interface Props {
  search: string;
  onNavigate(pathname: string): void;
}

type LoadStatus = 'loading' | 'ready' | 'error';

export function MyLibraryPage({ search, onNavigate }: Props) {
  const session = useMemberSession();
  const requestedTab = new URLSearchParams(search).get('tab');
  const tab = requestedTab === 'collections' || requestedTab === 'tones' ? requestedTab : 'likes';
  const [tones, setTones] = useState<PublishedPreset[]>([]);
  const [collections, setCollections] = useState<PresetCollection[]>([]);
  const [toneStatus, setToneStatus] = useState<LoadStatus>('loading');
  const [collectionStatus, setCollectionStatus] = useState<LoadStatus>('loading');
  const [toneMessage, setToneMessage] = useState('');
  const [collectionMessage, setCollectionMessage] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (session.status !== 'authenticated') return;
    let active = true;
    void marketplaceClient.listManagedPublishedPresets().then((items) => {
      if (active) { setTones(items); setToneStatus('ready'); }
    }, (cause: unknown) => {
      if (active) { setToneMessage(cause instanceof Error ? cause.message : 'My Tones 暂时不可用。'); setToneStatus('error'); }
    });
    void marketplaceClient.listManagedPresetCollections().then((items) => {
      if (active) { setCollections(items); setCollectionStatus('ready'); }
    }, (cause: unknown) => {
      if (active) { setCollectionMessage(cause instanceof Error ? cause.message : 'My Collections 暂时不可用。'); setCollectionStatus('error'); }
    });
    return () => { active = false; };
  }, [session.status]);

  if (session.status === 'loading') return <section className="library-page"><p>Loading My Library…</p></section>;
  if (session.status !== 'authenticated') return <section className="library-page app-route-placeholder"><h1>My Library</h1><p>登录后管理你的线上关系；浏览器 Local Preset 不会上传或出现在这里。</p><button type="button" onClick={() => onNavigate('/login?return=%2Flibrary')}>Sign in</button></section>;

  return (
    <section className="library-page">
      <span className="marketplace-detail__eyebrow">Private member workspace</span><h1>My Library</h1>
      <nav className="library-page__tabs" aria-label="Library sections">
        <button type="button" aria-current={tab === 'likes' ? 'page' : undefined} onClick={() => onNavigate('/library?tab=likes')}>My Likes</button>
        <button type="button" aria-current={tab === 'collections' ? 'page' : undefined} onClick={() => onNavigate('/library?tab=collections')}>My Collections</button>
        <button type="button" aria-current={tab === 'tones' ? 'page' : undefined} onClick={() => onNavigate('/library?tab=tones')}>My Tones</button>
      </nav>

      {tab === 'likes' ? <MarketplaceMyLikesPanel onNavigate={onNavigate} /> : tab === 'tones' ? <>
        <p><strong>My Tones</strong> 包含你拥有的 Public、Unlisted 和 Withdrawn 作品。Local Preset 只属于当前浏览器，不在此同步。</p>
        {toneStatus === 'loading' && <p>正在读取 My Tones…</p>}
        {toneStatus === 'error' && <p role="alert">{toneMessage}</p>}
        {toneStatus === 'ready' && tones.length === 0 && <div className="marketplace-search__empty"><strong>还没有线上 Tone</strong><p>从当前 Pedalboard Rig 开始创作。</p><button type="button" onClick={() => onNavigate('/')}>Open Pedalboard to Create</button></div>}
        <div className="library-page__tones">{tones.map((tone) => <article key={tone.id}><div><h2>{tone.title}</h2><span className={`library-page__visibility ${tone.visibility}`}>{tone.visibility}</span></div><p>{tone.description || '没有介绍。'}</p><small>revision {tone.currentRevision.id} · updated {new Date(tone.updatedAt).toLocaleString()}</small><div><button type="button" onClick={() => onNavigate(`/marketplace/tones/${encodeURIComponent(tone.id)}`)}>View</button><button type="button" onClick={() => onNavigate(`/library/tones/${encodeURIComponent(tone.id)}`)}>Manage</button></div></article>)}</div>
      </> : <>
        <div className="library-page__intro"><p><strong>My Collections</strong> 是线上策展作品；每个条目固定到一个具体 Revision，不会随原 Tone 自动变声。</p><button type="button" onClick={() => setCreating((value) => !value)}>{creating ? '取消创建' : 'New Collection'}</button></div>
        {creating && <CreatePresetCollectionForm onCancel={() => setCreating(false)} onCreated={(pathname) => {
          const id = pathname.split('/').pop() ?? '';
          onNavigate(`/library/collections/${id}`);
        }} />}
        {collectionStatus === 'loading' && <p>正在读取 My Collections…</p>}
        {collectionStatus === 'error' && <p role="alert">{collectionMessage}</p>}
        {collectionStatus === 'ready' && collections.length === 0 && !creating && <div className="marketplace-search__empty"><strong>还没有 Collection</strong><p>创建一个 Unlisted Collection，再从 Tone 详情加入固定修订。</p><button type="button" onClick={() => setCreating(true)}>Create Collection</button></div>}
        <div className="library-page__tones">{collections.map((collection) => <article key={collection.id}><div><h2>{collection.title}</h2><span className={`library-page__visibility ${collection.visibility}`}>{collection.visibility}</span></div><p>{collection.description || '没有介绍。'}</p><small>{collection.items.length} fixed revisions · updated {new Date(collection.updatedAt).toLocaleString()}</small><div><button type="button" onClick={() => onNavigate(`/marketplace/collections/${encodeURIComponent(collection.id)}`)}>View</button><button type="button" onClick={() => onNavigate(`/library/collections/${encodeURIComponent(collection.id)}`)}>Manage</button></div></article>)}</div>
      </>}
    </section>
  );
}
