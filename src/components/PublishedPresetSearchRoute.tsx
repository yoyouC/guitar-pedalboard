import { useEffect, useState, type FormEvent } from 'react';
import type {
  MarketplaceTag,
  PresetCollectionSearchItem,
  PublicCreatorSearchItem,
  PublishedPresetSearchItem,
  PublishedPresetSearchRequest,
  RigDerivedAttributes,
  RigResourceDependencyKey,
} from '../../shared/marketplace';
import { parseRigResourceDependencyKey } from '../../shared/marketplaceResource';
import { marketplaceClient } from '../marketplace/client';

interface PublishedPresetSearchRouteProps {
  pathname: string;
  onClose(): void;
  onNavigate(pathname: string): void;
}

type DiscoveryTab = 'presets' | 'collections' | 'creators';

function commaValues(value: string): string[] {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
}

function resourceDependencyValues(value: string): RigResourceDependencyKey[] | null {
  const parsed = commaValues(value).map(parseRigResourceDependencyKey);
  return parsed.some((key) => key === null)
    ? null
    : parsed as RigResourceDependencyKey[];
}

function isoDate(value: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

export function PublishedPresetSearchRoute({
  pathname,
  onClose,
  onNavigate,
}: PublishedPresetSearchRouteProps) {
  const active = pathname === '/marketplace/search' || pathname === '/marketplace/search/';
  const [tab, setTab] = useState<DiscoveryTab>('presets');
  const [text, setText] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [pedals, setPedals] = useState('');
  const [amps, setAmps] = useState('');
  const [cabs, setCabs] = useState('');
  const [resourceKinds, setResourceKinds] = useState<RigDerivedAttributes['resourceKinds']>([]);
  const [resourceDependencies, setResourceDependencies] = useState('');
  const [publishedAfter, setPublishedAfter] = useState('');
  const [publishedBefore, setPublishedBefore] = useState('');
  const [tags, setTags] = useState<MarketplaceTag[]>([]);
  const [items, setItems] = useState<PublishedPresetSearchItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [lastRequest, setLastRequest] = useState<PublishedPresetSearchRequest>({ limit: 12 });
  const [collectionItems, setCollectionItems] = useState<PresetCollectionSearchItem[]>([]);
  const [collectionCursor, setCollectionCursor] = useState<string | null>(null);
  const [collectionText, setCollectionText] = useState('');
  const [creatorItems, setCreatorItems] = useState<PublicCreatorSearchItem[]>([]);
  const [creatorCursor, setCreatorCursor] = useState<string | null>(null);
  const [creatorText, setCreatorText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const runSearch = async (request: PublishedPresetSearchRequest, append: boolean) => {
    setBusy(true);
    setMessage('');
    try {
      const page = await marketplaceClient.searchPublishedPresets(request);
      setItems((current) => append ? [...current, ...page.items] : page.items);
      setNextCursor(page.nextCursor);
      if (!append) setLastRequest({ ...request, cursor: undefined });
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '搜索暂时不可用。');
    } finally {
      setBusy(false);
    }
  };

  const runCollectionSearch = async (query: string, cursor: string | null, append: boolean) => {
    setBusy(true);
    setMessage('');
    try {
      const page = await marketplaceClient.searchPresetCollections({
        text: query, limit: 12, cursor: cursor ?? undefined,
      });
      setCollectionItems((current) => append ? [...current, ...page.items] : page.items);
      setCollectionCursor(page.nextCursor);
      if (!append) setCollectionText(query);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '合集搜索暂时不可用。');
    } finally {
      setBusy(false);
    }
  };

  const runCreatorSearch = async (query: string, cursor: string | null, append: boolean) => {
    setBusy(true);
    setMessage('');
    try {
      const page = await marketplaceClient.searchCreators({
        text: query, limit: 12, cursor: cursor ?? undefined,
      });
      setCreatorItems((current) => append ? [...current, ...page.items] : page.items);
      setCreatorCursor(page.nextCursor);
      if (!append) setCreatorText(query);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '创作者搜索暂时不可用。');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!active) return;
    let mounted = true;
    void marketplaceClient.listAvailableTags().then(
      (available) => { if (mounted) setTags(available); },
      () => { /* search remains usable without the tag picker */ },
    );
    void runSearch({ limit: 12 }, false);
    return () => { mounted = false; };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const previousTitle = document.title;
    document.title = '搜索音色广场 · Guitar Pedalboard';
    return () => { document.title = previousTitle; };
  }, [active]);

  if (!active) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (tab === 'collections') {
      void runCollectionSearch(text, null, false);
      return;
    }
    if (tab === 'creators') {
      void runCreatorSearch(text, null, false);
      return;
    }
    const resourceDependencyKeys = resourceDependencyValues(resourceDependencies);
    if (!resourceDependencyKeys) {
      setMessage('资源依赖格式应为 builtin、tone3000:<toneId> 或 tone3000:<toneId>:<modelId>。');
      return;
    }
    void runSearch({
      text,
      tagIds,
      pedalIds: commaValues(pedals),
      ampIds: commaValues(amps),
      cabIds: commaValues(cabs),
      resourceKinds,
      resourceDependencyKeys,
      publishedAfter: isoDate(publishedAfter),
      publishedBefore: isoDate(publishedBefore),
      limit: 12,
    }, false);
  };

  return (
    <section className="marketplace-detail marketplace-search" aria-live="polite">
      <div className="marketplace-detail__topline">
        <span className="marketplace-detail__eyebrow">音色广场 · Unified Discovery</span>
        <button className="marketplace-detail__close" type="button" onClick={onClose}>返回效果器</button>
      </div>
      <nav className="marketplace-search__tabs" aria-label="发现类型">
        {([
          ['presets', '预设'],
          ['collections', '合集'],
          ['creators', '创作者'],
        ] as const).map(([kind, label]) => (
          <button
            key={kind}
            type="button"
            aria-pressed={tab === kind}
            onClick={() => {
              setTab(kind);
              setMessage('');
              if (kind === 'collections' && collectionItems.length === 0) {
                void runCollectionSearch(text, null, false);
              }
              if (kind === 'creators' && creatorItems.length === 0) {
                void runCreatorSearch(text, null, false);
              }
            }}
          >{label}</button>
        ))}
      </nav>
      <form className="marketplace-search__form" onSubmit={submit}>
        <label>
          {tab === 'presets'
            ? '搜索预设标题、介绍、创作者或标签'
            : tab === 'collections'
              ? '搜索合集标题、介绍、标签或作者'
              : '搜索创作者 handle 或显示名'}
          <input value={text} placeholder="例如：rock、摇滚、distortion" onChange={(event) => setText(event.target.value)} />
        </label>
        {tab === 'presets' && <fieldset>
          <legend>受控标签</legend>
          <div className="preset-manager__tags">
            {tags.map((tag) => (
              <label key={tag.id}>
                <input
                  type="checkbox"
                  checked={tagIds.includes(tag.id)}
                  onChange={() => setTagIds((current) => current.includes(tag.id)
                    ? current.filter((id) => id !== tag.id)
                    : [...current, tag.id])}
                />
                {tag.nameZh} / {tag.nameEn}
              </label>
            ))}
          </div>
        </fieldset>}
        {tab === 'presets' && <label>
          精确资源依赖（逗号分隔）
          <input
            value={resourceDependencies}
            placeholder="builtin、tone3000:123 或 tone3000:123:456"
            onChange={(event) => setResourceDependencies(event.target.value)}
          />
        </label>}
        {tab === 'presets' && <div className="marketplace-search__filters">
          <label>Pedal ids（逗号分隔）<input value={pedals} onChange={(event) => setPedals(event.target.value)} /></label>
          <label>Amp ids（逗号分隔）<input value={amps} onChange={(event) => setAmps(event.target.value)} /></label>
          <label>Cab ids（逗号分隔）<input value={cabs} onChange={(event) => setCabs(event.target.value)} /></label>
          <label>发布起点<input type="datetime-local" value={publishedAfter} onChange={(event) => setPublishedAfter(event.target.value)} /></label>
          <label>发布终点<input type="datetime-local" value={publishedBefore} onChange={(event) => setPublishedBefore(event.target.value)} /></label>
        </div>}
        {tab === 'presets' && <fieldset>
          <legend>资源依赖</legend>
          <div className="preset-manager__tags">
            {(['builtin', 'tone3000'] as const).map((kind) => (
              <label key={kind}>
                <input
                  type="checkbox"
                  checked={resourceKinds.includes(kind)}
                  onChange={() => setResourceKinds((current) => current.includes(kind)
                    ? current.filter((item) => item !== kind)
                    : [...current, kind])}
                />
                {kind}
              </label>
            ))}
          </div>
        </fieldset>}
        <button type="submit" disabled={busy}>{busy ? '搜索中…' : '搜索公开内容'}</button>
        {tab === 'presets' && <small>器材筛选只读取发布时派生的 Pedal / Amp / Cab / 资源身份，不搜索旋钮值或任意 Rig JSON。</small>}
      </form>
      {message && <p className="marketplace-detail__error" role="alert">{message}</p>}
      {tab === 'presets' && <div className="marketplace-search__results">
        {items.map((item) => (
          <article key={item.id}>
            <button type="button" onClick={() => onNavigate(
              `/marketplace/presets/${encodeURIComponent(item.id)}`
            )}>{item.title}</button>
            <p>{item.description || '作者没有填写介绍。'}</p>
            <small>@{item.creator.handle} · {item.tags.map((tag) => tag.nameZh).join(' · ')}</small>
            <small>{item.derivedAttributes.pedalIds.join('、') || 'No pedals'} → {item.derivedAttributes.ampId} → {item.derivedAttributes.cabId}</small>
          </article>
        ))}
      </div>}
      {tab === 'collections' && <div className="marketplace-search__results">
        {collectionItems.map((item) => (
          <article key={item.id}>
            <button type="button" onClick={() => onNavigate(item.url)}>{item.title}</button>
            <p>{item.description || '作者没有填写介绍。'}</p>
            <small>@{item.creator.handle} · {item.tags.map((tag) => tag.nameZh).join(' · ')}</small>
          </article>
        ))}
      </div>}
      {tab === 'creators' && <div className="marketplace-search__results">
        {creatorItems.map((item) => (
          <article key={item.id}>
            <button type="button" onClick={() => onNavigate(item.url)}>{item.displayName}</button>
            <p>@{item.handle}</p>
            <small>{item.bio || '创作者没有填写简介。'}</small>
          </article>
        ))}
      </div>}
      {!busy && !message && tab === 'presets' && items.length === 0 && <p>没有匹配的公开预设。</p>}
      {!busy && !message && tab === 'collections' && collectionItems.length === 0 && <p>没有匹配的公开合集。</p>}
      {!busy && !message && tab === 'creators' && creatorItems.length === 0 && <p>没有匹配的创作者。</p>}
      {tab === 'presets' && nextCursor && (
        <button type="button" disabled={busy} onClick={() => void runSearch({
          ...lastRequest,
          cursor: nextCursor,
        }, true)}>加载更多</button>
      )}
      {tab === 'collections' && collectionCursor && (
        <button type="button" disabled={busy} onClick={() => void runCollectionSearch(
          collectionText, collectionCursor, true,
        )}>加载更多合集</button>
      )}
      {tab === 'creators' && creatorCursor && (
        <button type="button" disabled={busy} onClick={() => void runCreatorSearch(
          creatorText, creatorCursor, true,
        )}>加载更多创作者</button>
      )}
    </section>
  );
}
