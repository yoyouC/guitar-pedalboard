import { useEffect, useState, type FormEvent } from 'react';
import type {
  MarketplaceTag,
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
        <span className="marketplace-detail__eyebrow">音色广场 · Published Preset Search</span>
        <button className="marketplace-detail__close" type="button" onClick={onClose}>返回效果器</button>
      </div>
      <form className="marketplace-search__form" onSubmit={submit}>
        <label>
          搜索标题、介绍、创作者或标签
          <input value={text} placeholder="例如：rock、摇滚、distortion" onChange={(event) => setText(event.target.value)} />
        </label>
        <fieldset>
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
        </fieldset>
        <label>
          精确资源依赖（逗号分隔）
          <input
            value={resourceDependencies}
            placeholder="builtin、tone3000:123 或 tone3000:123:456"
            onChange={(event) => setResourceDependencies(event.target.value)}
          />
        </label>
        <div className="marketplace-search__filters">
          <label>Pedal ids（逗号分隔）<input value={pedals} onChange={(event) => setPedals(event.target.value)} /></label>
          <label>Amp ids（逗号分隔）<input value={amps} onChange={(event) => setAmps(event.target.value)} /></label>
          <label>Cab ids（逗号分隔）<input value={cabs} onChange={(event) => setCabs(event.target.value)} /></label>
          <label>发布起点<input type="datetime-local" value={publishedAfter} onChange={(event) => setPublishedAfter(event.target.value)} /></label>
          <label>发布终点<input type="datetime-local" value={publishedBefore} onChange={(event) => setPublishedBefore(event.target.value)} /></label>
        </div>
        <fieldset>
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
        </fieldset>
        <button type="submit" disabled={busy}>{busy ? '搜索中…' : '搜索公开预设'}</button>
        <small>器材筛选只读取发布时派生的 Pedal / Amp / Cab / 资源身份，不搜索旋钮值或任意 Rig JSON。</small>
      </form>
      {message && <p className="marketplace-detail__error" role="alert">{message}</p>}
      <div className="marketplace-search__results">
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
      </div>
      {!busy && items.length === 0 && !message && <p>没有匹配的公开预设。</p>}
      {nextCursor && (
        <button type="button" disabled={busy} onClick={() => void runSearch({
          ...lastRequest,
          cursor: nextCursor,
        }, true)}>加载更多</button>
      )}
    </section>
  );
}
