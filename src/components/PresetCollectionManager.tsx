import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  MarketplaceTag,
  PresetCollection,
  PresetCollectionItem,
  PublishedPreset,
  PublishedPresetSearchItem,
} from '../../shared/marketplace';
import { validatePublicationFields, type PublicationErrors } from '../../shared/marketplacePublication';
import { MarketplaceClientError, marketplaceClient } from '../marketplace/client';

interface PresetCollectionManagerProps {
  collection: PresetCollection;
  onUpdated(collection: PresetCollection): void;
}

interface ToneChoice {
  preset: PublishedPreset;
  isPublic: boolean;
}

function positioned(items: PresetCollectionItem[]): PresetCollectionItem[] {
  return items.map((item, position) => ({ ...item, position }));
}

export function PresetCollectionManager({ collection, onUpdated }: PresetCollectionManagerProps) {
  const [title, setTitle] = useState(collection.title);
  const [description, setDescription] = useState(collection.description);
  const [tagIds, setTagIds] = useState(collection.tags.map((tag) => tag.id));
  const [visibility, setVisibility] = useState<'public' | 'unlisted' | 'withdrawn'>(
    collection.visibility === 'hidden' ? 'withdrawn' : collection.visibility,
  );
  const [items, setItems] = useState<PresetCollectionItem[]>(positioned(collection.items));
  const [tags, setTags] = useState<MarketplaceTag[]>([]);
  const [myTones, setMyTones] = useState<PublishedPreset[]>([]);
  const [choices, setChoices] = useState<Record<string, ToneChoice>>({});
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PublishedPresetSearchItem[]>([]);
  const [errors, setErrors] = useState<PublicationErrors>({});
  const [itemError, setItemError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflicted, setConflicted] = useState(false);

  useEffect(() => {
    setTitle(collection.title);
    setDescription(collection.description);
    setTagIds(collection.tags.map((tag) => tag.id));
    setVisibility(collection.visibility === 'hidden' ? 'withdrawn' : collection.visibility);
    setItems(positioned(collection.items));
    setConflicted(false);
  }, [collection]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      marketplaceClient.listAvailableTags(),
      marketplaceClient.listManagedPublishedPresets(),
    ]).then(([availableTags, ownedTones]) => {
      if (!active) return;
      setTags(availableTags);
      setMyTones(ownedTones);
      setChoices((current) => ({
        ...current,
        ...Object.fromEntries(ownedTones.map((preset) => [preset.id, {
          preset,
          isPublic: preset.visibility === 'public',
        }])),
      }));
    }, (cause: unknown) => {
      if (active) setMessage(cause instanceof Error ? cause.message : '无法读取可选 Tone。');
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    for (const item of items) {
      if (choices[item.presetId]) continue;
      void marketplaceClient.getPublishedPreset(item.presetId).then((preset) => {
        if (active) setChoices((current) => ({
          ...current,
          [preset.id]: { preset, isPublic: true },
        }));
      }, () => undefined);
    }
    return () => { active = false; };
  }, [choices, items]);

  const canSetPublic = collection.visibility === 'public' || items.some((item) => (
    choices[item.presetId]?.isPublic
  ));
  const included = useMemo(() => new Set(items.map((item) => (
    `${item.presetId}\u0000${item.revisionId}`
  ))), [items]);

  const move = (index: number, offset: -1 | 1) => {
    setItems((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return positioned(next);
    });
  };

  const appendPreset = (preset: PublishedPreset, isPublic: boolean) => {
    const key = `${preset.id}\u0000${preset.currentRevision.id}`;
    if (included.has(key)) {
      setItemError('这个固定修订已经在合集里。');
      return;
    }
    setChoices((current) => ({ ...current, [preset.id]: { preset, isPublic } }));
    setItems((current) => positioned([...current, {
      position: current.length,
      presetId: preset.id,
      revisionId: preset.currentRevision.id,
      availability: 'available',
      title: preset.title,
      creator: preset.creator,
    }]));
    setItemError('');
  };

  const upgradeItem = (index: number, choice: ToneChoice) => {
    const revisionId = choice.preset.currentRevision.id;
    const key = `${choice.preset.id}\u0000${revisionId}`;
    if (items.some((item, itemIndex) => (
      itemIndex !== index && `${item.presetId}\u0000${item.revisionId}` === key
    ))) {
      setItemError('目标修订已经在合集的另一个位置。');
      return;
    }
    setItems((current) => positioned(current.map((entry, itemIndex) => itemIndex === index ? {
      ...entry,
      revisionId,
      title: choice.preset.title,
      availability: 'available',
    } : entry)));
    setItemError('');
  };

  const addSearchResult = async (result: PublishedPresetSearchItem) => {
    setBusy(true);
    setMessage('');
    try {
      appendPreset(await marketplaceClient.getPublishedPreset(result.id), true);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '无法读取这个 Tone。');
    } finally {
      setBusy(false);
    }
  };

  const search = async () => {
    setBusy(true);
    setMessage('');
    try {
      const page = await marketplaceClient.searchPublishedPresets({ text: query.trim() || undefined, limit: 12 });
      setSearchResults(page.items);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '搜索 Tone 失败。');
    } finally {
      setBusy(false);
    }
  };

  const reload = async () => {
    setBusy(true);
    try {
      onUpdated(await marketplaceClient.getManagedPresetCollection(collection.id));
      setMessage('已重新载入服务器上的最新版本。');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '重新载入失败。');
    } finally {
      setBusy(false);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const nextErrors = validatePublicationFields({ title, description, tagIds });
    setErrors(nextErrors);
    if (visibility === 'public' && !canSetPublic) {
      setItemError('至少加入一个当前 Public Tone，才能公开合集。');
      return;
    }
    if (Object.keys(nextErrors).length > 0) return;
    setBusy(true);
    setMessage('');
    setConflicted(false);
    try {
      const updated = await marketplaceClient.updatePresetCollection(collection.id, {
        title,
        description,
        tagIds,
        visibility,
        items: items.map(({ presetId, revisionId }) => ({ presetId, revisionId })),
        expectedUpdatedAt: collection.updatedAt,
      });
      onUpdated(updated);
      setMessage('合集已更新；条目仍固定到所示 revision。');
    } catch (cause) {
      if (cause instanceof MarketplaceClientError && cause.fields) {
        setErrors(cause.fields);
        if (cause.fields.items) setItemError(cause.fields.items);
      }
      const conflict = cause instanceof MarketplaceClientError && cause.code === 'update_conflict';
      setConflicted(conflict);
      setMessage(conflict
        ? '合集已在别处更新。请重新载入；不会强制覆盖。'
        : cause instanceof Error ? cause.message : '合集更新失败。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="preset-manager" aria-label="管理预设合集">
      <div><span className="marketplace-detail__eyebrow">Creator workspace</span><h2>Manage Collection</h2></div>
      <form onSubmit={(event) => void save(event)}>
        <label>标题<input value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} />{errors.title && <small className="preset-manager__error">{errors.title}</small>}</label>
        <label>介绍<textarea value={description} maxLength={2000} onChange={(event) => setDescription(event.target.value)} /></label>
        <fieldset><legend>标签（1–5）</legend><div className="preset-manager__tags">{tags.map((tag) => <label key={tag.id}><input type="checkbox" checked={tagIds.includes(tag.id)} onChange={() => setTagIds((current) => current.includes(tag.id) ? current.filter((id) => id !== tag.id) : [...current, tag.id])} />{tag.nameZh} / {tag.nameEn}</label>)}</div>{errors.tagIds && <small className="preset-manager__error">{errors.tagIds}</small>}</fieldset>
        <label>可见性<select value={visibility} onChange={(event) => setVisibility(event.target.value as typeof visibility)}><option value="public" disabled={!canSetPublic}>Public{!canSetPublic ? ' · 需要至少一个 Public Tone' : ''}</option><option value="unlisted">Unlisted</option><option value="withdrawn">撤回</option></select></label>

        <div className="preset-manager__section">
          <h3>固定 Revision 队列</h3>
          <small>发布者更新 Tone 不会自动改变这里的声音；只有点击 Upgrade 才会换到新修订。</small>
          <ol className="collection-manager__items">{items.map((item, index) => {
            const choice = choices[item.presetId];
            const latest = choice?.preset.currentRevision.id;
            return <li key={`${item.presetId}-${item.revisionId}`} className={item.availability === 'unavailable' ? 'unavailable' : ''}>
              <span className="collection-detail__position">{index + 1}</span>
              <div><strong>{item.title ?? '原作当前不可用'}</strong><small>@{item.creator.handle} · fixed revision {item.revisionId}</small>{choice && latest && latest !== item.revisionId && <button type="button" onClick={() => upgradeItem(index, choice)}>Upgrade to revision {latest}</button>}</div>
              <div className="preset-manager__buttons"><button type="button" disabled={index === 0} onClick={() => move(index, -1)}>上移</button><button type="button" disabled={index === items.length - 1} onClick={() => move(index, 1)}>下移</button><button type="button" onClick={() => setItems((current) => positioned(current.filter((_, itemIndex) => itemIndex !== index)))}>移除</button></div>
            </li>;
          })}</ol>
          {items.length === 0 && <p>合集还没有 Tone。先从自己的作品或公开搜索结果中选择。</p>}
          {itemError && <small className="preset-manager__error">{itemError}</small>}
        </div>

        <div className="collection-tone-picker">
          <h3>从 My Tones 选择当前 Revision</h3>
          <div className="collection-tone-picker__results">{myTones.filter((tone) => tone.visibility !== 'withdrawn').map((tone) => <button type="button" key={tone.id} disabled={included.has(`${tone.id}\u0000${tone.currentRevision.id}`)} onClick={() => appendPreset(tone, tone.visibility === 'public')}><strong>{tone.title}</strong><small>{tone.visibility} · current revision {tone.currentRevision.id}</small></button>)}</div>
          <h3>搜索 Public Tones</h3>
          <div className="collection-tone-picker__search"><input aria-label="搜索可加入合集的 Tone" value={query} onChange={(event) => setQuery(event.target.value)} /><button type="button" disabled={busy} onClick={() => void search()}>Search</button></div>
          <div className="collection-tone-picker__results">{searchResults.map((result) => <button type="button" key={result.id} disabled={busy} onClick={() => void addSearchResult(result)}><strong>{result.title}</strong><small>@{result.creator.handle} · choose current revision</small></button>)}</div>
        </div>

        <button type="submit" disabled={busy || conflicted}>{busy ? '保存中…' : '保存合集'}</button>
      </form>
      {message && <p className="preset-manager__message" role="status">{message}</p>}
      {conflicted && <button type="button" disabled={busy} onClick={() => void reload()}>Reload latest</button>}
    </section>
  );
}
