import { useEffect, useState } from 'react';
import type {
  MarketplaceMemberSummary,
  MarketplaceTag,
  PresetCollection,
} from '../../shared/marketplace';
import { marketplaceClient } from '../marketplace/client';

interface ToneReference {
  presetId: string;
  revisionId: string;
  title: string;
  creator: MarketplaceMemberSummary;
  visibility: 'public' | 'unlisted' | 'withdrawn';
}

interface Props {
  tone: ToneReference;
  onClose(): void;
  onNavigate(pathname: string): void;
}

function references(collection: PresetCollection) {
  return collection.items.map(({ presetId, revisionId }) => ({ presetId, revisionId }));
}

export function AddToCollectionDialog({ tone, onClose, onNavigate }: Props) {
  const [collections, setCollections] = useState<PresetCollection[]>([]);
  const [tags, setTags] = useState<MarketplaceTag[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newTagIds, setNewTagIds] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([
      marketplaceClient.listManagedPresetCollections(),
      marketplaceClient.listAvailableTags(),
    ]).then(([owned, availableTags]) => {
      if (!active) return;
      setCollections(owned.filter((collection) => collection.visibility !== 'withdrawn'));
      setTags(availableTags);
    }, (cause: unknown) => {
      if (!active) return;
      setMessage(cause instanceof Error ? cause.message : '无法读取 My Collections。');
    });
    return () => { active = false; };
  }, []);

  const add = async (collection: PresetCollection) => {
    const alreadyIncluded = collection.items.some((item) => (
      item.presetId === tone.presetId && item.revisionId === tone.revisionId
    ));
    if (alreadyIncluded) {
      setMessage('这个固定修订已经在该合集里。');
      return collection;
    }
    return marketplaceClient.updatePresetCollection(collection.id, {
      title: collection.title,
      description: collection.description,
      tagIds: collection.tags.map((tag) => tag.id),
      visibility: collection.visibility === 'hidden' ? 'unlisted' : collection.visibility,
      items: [...references(collection), {
        presetId: tone.presetId,
        revisionId: tone.revisionId,
      }],
      expectedUpdatedAt: collection.updatedAt,
    });
  };

  const addExisting = async () => {
    const collection = collections.find((item) => item.id === selectedId);
    if (!collection) return;
    setBusy(true);
    setMessage('');
    try {
      const updated = await add(collection);
      setCollections((current) => current.map((item) => item.id === updated.id ? updated : item));
      setMessage(`已将固定 revision ${tone.revisionId} 加入「${updated.title}」。`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '加入合集失败。');
    } finally {
      setBusy(false);
    }
  };

  const createAndAdd = async () => {
    if (!newTitle.trim() || newTagIds.length < 1 || newTagIds.length > 5) {
      setMessage('请填写标题并选择 1–5 个标签。');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const created = await marketplaceClient.createPresetCollection({
        title: newTitle.trim(),
        description: '',
        tagIds: newTagIds,
        visibility: 'unlisted',
      });
      const updated = await add(created);
      setCollections((current) => [updated, ...current]);
      setSelectedId(updated.id);
      setMessage(`已创建 Unlisted 合集「${updated.title}」并加入这个固定修订。`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '创建合集失败。');
    } finally {
      setBusy(false);
    }
  };

  const authenticationRequired = message.includes('登录');
  return (
    <div className="publish-dialog__backdrop" role="presentation">
      <section className="publish-dialog add-collection-dialog" role="dialog" aria-modal="true" aria-labelledby="add-collection-title">
        <header className="publish-dialog__header">
          <div>
            <span className="marketplace-detail__eyebrow">Fixed revision</span>
            <h2 id="add-collection-title">Add to Collection</h2>
          </div>
          <button type="button" onClick={onClose}>关闭</button>
        </header>
        <p><strong>{tone.title}</strong> · @{tone.creator.handle} · revision {tone.revisionId}</p>
        <label>
          选择已有 Collection
          <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
            <option value="">选择合集…</option>
            {collections.map((collection) => {
              const incompatible = collection.visibility === 'public' && tone.visibility !== 'public';
              const duplicate = collection.items.some((item) => (
                item.presetId === tone.presetId && item.revisionId === tone.revisionId
              ));
              return (
                <option key={collection.id} value={collection.id} disabled={incompatible || duplicate}>
                  {collection.title} · {collection.visibility} · {collection.items.length} tones
                  {duplicate ? ' · 已加入' : incompatible ? ' · 需 Public Tone' : ''}
                </option>
              );
            })}
          </select>
        </label>
        <button type="button" disabled={!selectedId || busy} onClick={() => void addExisting()}>
          加入所选 Collection
        </button>
        <div className="add-collection-dialog__new">
          <h3>或创建新的 Unlisted Collection</h3>
          <label>标题<input value={newTitle} maxLength={80} onChange={(event) => setNewTitle(event.target.value)} /></label>
          <fieldset>
            <legend>标签（1–5）</legend>
            <div className="preset-manager__tags">{tags.map((tag) => (
              <label key={tag.id}><input type="checkbox" checked={newTagIds.includes(tag.id)} onChange={() => setNewTagIds((current) => current.includes(tag.id) ? current.filter((id) => id !== tag.id) : [...current, tag.id])} />{tag.nameZh}</label>
            ))}</div>
          </fieldset>
          <button type="button" disabled={busy} onClick={() => void createAndAdd()}>创建并加入</button>
        </div>
        {message && <p role="status">{message}</p>}
        {authenticationRequired && <button type="button" onClick={() => onNavigate('/login?return=' + encodeURIComponent(window.location.pathname))}>Sign in</button>}
      </section>
    </div>
  );
}
