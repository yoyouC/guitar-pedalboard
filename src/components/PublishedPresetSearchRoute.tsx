import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  MarketplaceTag,
  PresetCollectionSearchItem,
  PublicCreatorSearchItem,
  PublishedPresetSearchItem,
  RigDerivedAttributes,
  RigResourceDependencyKey,
} from '../../shared/marketplace';
import { parseRigResourceDependencyKey } from '../../shared/marketplaceResource';
import { AMP_REGISTRY } from '../audio/amps';
import { CAB_SELECTOR_REGISTRY } from '../audio/cabs';
import { EFFECT_REGISTRY } from '../audio/effects';
import { marketplaceClient } from '../marketplace/client';
import { marketplaceSearchPath, marketplaceSearchRouteState } from '../marketplace/searchRoute';
import { tonePath } from '../marketplace/route';
import { MarketplaceLikeButton } from './MarketplaceLikeButton.tsx';

interface PublishedPresetSearchRouteProps {
  pathname: string;
  search: string;
  onClose(): void;
  onNavigate(pathname: string): void;
}

type DiscoveryTab = 'presets' | 'collections' | 'creators';

function commaValues(value: string): string[] {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
}

function resourceDependencyValues(value: string): RigResourceDependencyKey[] | null {
  const parsed = commaValues(value).map(parseRigResourceDependencyKey);
  return parsed.some((key) => key === null) ? null : parsed as RigResourceDependencyKey[];
}

function isoDate(value: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function localDate(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function dependencySummary(item: PublishedPresetSearchItem): string {
  return item.resourceDependencies.map((dependency) => dependency.kind === 'builtin'
    ? 'Built-in'
    : `TONE3000 ${dependency.toneId}${dependency.modelId ? `/${dependency.modelId}` : ''}`
  ).join(' · ');
}

export function PublishedPresetSearchRoute({
  pathname,
  search,
  onClose,
  onNavigate,
}: PublishedPresetSearchRouteProps) {
  const active = pathname === '/marketplace' || pathname === '/marketplace/';
  const routeState = useMemo(() => marketplaceSearchRouteState(search), [search]);
  const request = routeState.request;
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
  const [collectionItems, setCollectionItems] = useState<PresetCollectionSearchItem[]>([]);
  const [collectionCursor, setCollectionCursor] = useState<string | null>(null);
  const [collectionText, setCollectionText] = useState('');
  const [creatorItems, setCreatorItems] = useState<PublicCreatorSearchItem[]>([]);
  const [creatorCursor, setCreatorCursor] = useState<string | null>(null);
  const [creatorText, setCreatorText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!active) return;
    setText(request.text ?? '');
    setTagIds(request.tagIds ?? []);
    setPedals((request.pedalIds ?? []).join(', '));
    setAmps((request.ampIds ?? []).join(', '));
    setCabs((request.cabIds ?? []).join(', '));
    setResourceKinds(request.resourceKinds ?? []);
    setResourceDependencies((request.resourceDependencyKeys ?? []).join(', '));
    setPublishedAfter(localDate(request.publishedAfter));
    setPublishedBefore(localDate(request.publishedBefore));
  }, [active, request]);

  const runCollectionSearch = async (query: string, cursor: string | null, append: boolean) => {
    setBusy(true);
    setMessage('');
    try {
      const page = await marketplaceClient.searchPresetCollections({
        text: query, limit: 12, cursor: cursor ?? undefined,
      });
      setCollectionItems((current) => append ? [...current, ...page.items] : page.items);
      setCollectionCursor(page.nextCursor);
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
      () => { /* free text and equipment filters remain usable */ },
    );
    return () => { mounted = false; };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const previousTitle = document.title;
    document.title = 'Tone Market · Guitar Pedalboard';
    return () => { document.title = previousTitle; };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    if (routeState.error) {
      setItems([]);
      setNextCursor(null);
      setMessage(routeState.error);
      return;
    }
    let mounted = true;
    setBusy(true);
    setMessage('');
    void marketplaceClient.searchPublishedPresets(request).then(
      (page) => {
        if (!mounted) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setBusy(false);
      },
      (cause: unknown) => {
        if (!mounted) return;
        setItems([]);
        setNextCursor(null);
        setMessage(cause instanceof Error ? cause.message : 'Tone Market 暂时不可用。');
        setBusy(false);
      },
    );
    return () => { mounted = false; };
  }, [active, request, routeState.error]);

  if (!active) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (tab === 'collections') {
      void runCollectionSearch(collectionText, null, false);
      return;
    }
    if (tab === 'creators') {
      void runCreatorSearch(creatorText, null, false);
      return;
    }
    const resourceDependencyKeys = resourceDependencyValues(resourceDependencies);
    if (!resourceDependencyKeys) {
      setMessage('资源依赖格式应为 builtin、tone3000:<toneId> 或 tone3000:<toneId>:<modelId>。');
      return;
    }
    onNavigate(marketplaceSearchPath({
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
    }));
  };

  return (
    <section className="marketplace-detail marketplace-search" aria-live="polite">
      <div className="marketplace-detail__topline">
        <span className="marketplace-detail__eyebrow">Tone Market · Unified discovery</span>
        <button className="marketplace-detail__close" type="button" onClick={onClose}>返回效果器</button>
      </div>
      <h1>找到下一种声音</h1>
      <nav className="marketplace-search__tabs" aria-label="Tone Market discovery views">
        <button type="button" aria-pressed>Search</button>
        <button type="button" onClick={() => onNavigate('/marketplace/popular')}>Popular</button>
        <button type="button" onClick={() => onNavigate('/marketplace/trending')}>Trending</button>
        <button type="button" onClick={() => onNavigate('/marketplace/latest')}>Latest</button>
      </nav>
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
                void runCollectionSearch(collectionText, null, false);
              }
              if (kind === 'creators' && creatorItems.length === 0) {
                void runCreatorSearch(creatorText, null, false);
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
          <input
            value={tab === 'presets' ? text : tab === 'collections' ? collectionText : creatorText}
            placeholder="例如：rock、摇滚、distortion"
            onChange={(event) => {
              if (tab === 'presets') setText(event.target.value);
              else if (tab === 'collections') setCollectionText(event.target.value);
              else setCreatorText(event.target.value);
            }}
          />
        </label>
        {tab === 'presets' && <fieldset>
          <legend>受控标签</legend>
          <div className="preset-manager__tags">
            {tags.map((tag) => (
              <label key={tag.id}>
                <input type="checkbox" checked={tagIds.includes(tag.id)} onChange={() => setTagIds((current) => current.includes(tag.id) ? current.filter((id) => id !== tag.id) : [...current, tag.id])} />
                {tag.nameZh} / {tag.nameEn}
              </label>
            ))}
          </div>
        </fieldset>}
        {tab === 'presets' && <div className="marketplace-search__filters">
          <label>Pedal（名称或 id，逗号分隔）<input list="market-pedals" value={pedals} onChange={(event) => setPedals(event.target.value)} /></label>
          <label>Amp（名称或 id，逗号分隔）<input list="market-amps" value={amps} onChange={(event) => setAmps(event.target.value)} /></label>
          <label>Cab（名称或 id，逗号分隔）<input list="market-cabs" value={cabs} onChange={(event) => setCabs(event.target.value)} /></label>
          <label>发布起点<input type="datetime-local" value={publishedAfter} onChange={(event) => setPublishedAfter(event.target.value)} /></label>
          <label>发布终点<input type="datetime-local" value={publishedBefore} onChange={(event) => setPublishedBefore(event.target.value)} /></label>
        </div>}
        <datalist id="market-pedals">{EFFECT_REGISTRY.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</datalist>
        <datalist id="market-amps">{AMP_REGISTRY.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</datalist>
        <datalist id="market-cabs">{CAB_SELECTOR_REGISTRY.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</datalist>
        {tab === 'presets' && <fieldset>
          <legend>资源类型</legend>
          <div className="preset-manager__tags">
            {(['builtin', 'tone3000'] as const).map((kind) => (
              <label key={kind}><input type="checkbox" checked={resourceKinds.includes(kind)} onChange={() => setResourceKinds((current) => current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind])} />{kind === 'builtin' ? '内置资源' : 'TONE3000'}</label>
            ))}
          </div>
        </fieldset>}
        {tab === 'presets' && <label>精确资源依赖<input value={resourceDependencies} placeholder="builtin、tone3000:123:456" onChange={(event) => setResourceDependencies(event.target.value)} /></label>}
        <button type="submit" disabled={busy}>{busy ? '搜索中…' : `搜索${tab === 'presets' ? ' Tone' : tab === 'collections' ? ' Collection' : ' Creator'}`}</button>
        {tab === 'presets' && <small>筛选会写入当前 URL，可直接分享，并可用浏览器 Back / Forward 恢复；只读取发布时派生的器材身份，不搜索旋钮值或任意 Rig JSON。</small>}
      </form>
      {message && <div className="marketplace-detail__error" role="alert"><strong>Tone Market 无法完成搜索</strong><p>{message}</p><small>你仍可返回效果器继续使用本地 Rig。</small></div>}
      {tab === 'presets' && <div className="marketplace-search__results">
        {items.map((item) => (
          <article key={item.id}>
            <button type="button" onClick={() => onNavigate(tonePath(item.id))}>{item.title}</button>
            <p>{item.description || '作者没有填写介绍。'}</p>
            <small>@{item.creator.handle} · {item.tags.map((tag) => tag.nameZh).join(' · ')}</small>
            <small>{item.derivedAttributes.pedalIds.join('、') || 'No pedals'} → {item.derivedAttributes.ampId} → {item.derivedAttributes.cabId}</small>
            <small>{dependencySummary(item)} · 发布于 {new Date(item.createdAt).toLocaleDateString()}{item.isRemix ? ' · Remix' : ''}</small>
            <MarketplaceLikeButton kind="preset" targetId={item.id} targetCreatorId={item.creator.id} onNavigate={onNavigate} />
          </article>
        ))}
      </div>}
      {tab === 'collections' && <div className="marketplace-search__results">
        {collectionItems.map((item) => (
          <article key={item.id}>
            <button type="button" onClick={() => onNavigate(item.url)}>{item.title}</button>
            <p>{item.description || '作者没有填写介绍。'}</p>
            <small>@{item.creator.handle} · {item.tags.map((tag) => tag.nameZh).join(' · ')}</small>
            <MarketplaceLikeButton kind="collection" targetId={item.id} targetCreatorId={item.creator.id} onNavigate={onNavigate} />
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
      {!busy && !message && tab === 'presets' && items.length === 0 && <div className="marketplace-search__empty"><strong>没有匹配的 Tone</strong><p>试试减少筛选条件或换一个关键词。</p></div>}
      {!busy && !message && tab === 'collections' && collectionItems.length === 0 && <div className="marketplace-search__empty"><strong>没有匹配的 Collection</strong><p>试试标题、介绍、标签或 Creator 名称。</p></div>}
      {!busy && !message && tab === 'creators' && creatorItems.length === 0 && <div className="marketplace-search__empty"><strong>没有匹配的 Creator</strong><p>试试 handle 或显示名。</p></div>}
      {tab === 'presets' && nextCursor && (
        <button type="button" disabled={busy} onClick={() => onNavigate(marketplaceSearchPath({ ...request, cursor: nextCursor }))}>下一页 Tone</button>
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
