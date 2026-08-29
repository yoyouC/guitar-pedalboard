import { useEffect, useState, type FormEvent } from 'react';
import type {
  MarketplaceTag,
  PresetCollection,
  PresetCollectionReference,
} from '../../shared/marketplace';
import { validatePublicationFields, type PublicationErrors } from '../../shared/marketplacePublication';
import { MarketplaceClientError, marketplaceClient } from '../marketplace/client';

interface PresetCollectionManagerProps {
  collection: PresetCollection;
  onUpdated(collection: PresetCollection): void;
}

export function PresetCollectionManager({ collection, onUpdated }: PresetCollectionManagerProps) {
  const [title, setTitle] = useState(collection.title);
  const [description, setDescription] = useState(collection.description);
  const [tagIds, setTagIds] = useState(collection.tags.map((tag) => tag.id));
  const [visibility, setVisibility] = useState<'public' | 'unlisted' | 'withdrawn'>(
    collection.visibility === 'hidden' ? 'withdrawn' : collection.visibility,
  );
  const [items, setItems] = useState<PresetCollectionReference[]>(
    collection.items.map(({ presetId, revisionId }) => ({ presetId, revisionId })),
  );
  const [tags, setTags] = useState<MarketplaceTag[]>([]);
  const [errors, setErrors] = useState<PublicationErrors>({});
  const [itemError, setItemError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTitle(collection.title);
    setDescription(collection.description);
    setTagIds(collection.tags.map((tag) => tag.id));
    setVisibility(collection.visibility === 'hidden' ? 'withdrawn' : collection.visibility);
    setItems(collection.items.map(({ presetId, revisionId }) => ({ presetId, revisionId })));
  }, [collection]);

  useEffect(() => {
    let active = true;
    void marketplaceClient.listAvailableTags().then(
      (available) => { if (active) setTags(available); },
      (cause: unknown) => {
        if (active) setMessage(cause instanceof Error ? cause.message : '无法读取标签。');
      },
    );
    return () => { active = false; };
  }, []);

  const updateItem = (index: number, field: keyof PresetCollectionReference, value: string) => {
    setItems((current) => current.map((item, itemIndex) => (
      itemIndex === index ? { ...item, [field]: value } : item
    )));
  };

  const move = (index: number, offset: -1 | 1) => {
    setItems((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const nextErrors = validatePublicationFields({ title, description, tagIds });
    setErrors(nextErrors);
    const invalidItems = items.some((item) => !item.presetId || !item.revisionId);
    const keys = items.map((item) => `${item.presetId}\u0000${item.revisionId}`);
    const duplicateItems = new Set(keys).size !== keys.length;
    setItemError(invalidItems
      ? 'Preset id 和 revision id 不能为空。'
      : duplicateItems ? '同一固定修订不能重复。' : '');
    if (Object.keys(nextErrors).length > 0 || invalidItems || duplicateItems) return;
    setBusy(true);
    setMessage('');
    try {
      const updated = await marketplaceClient.updatePresetCollection(collection.id, {
        title,
        description,
        tagIds,
        visibility,
        items,
        expectedUpdatedAt: collection.updatedAt,
      });
      onUpdated(updated);
      setMessage('合集已更新。');
    } catch (cause) {
      if (cause instanceof MarketplaceClientError && cause.fields) {
        setErrors(cause.fields);
        if (cause.fields.items) setItemError(cause.fields.items);
      }
      setMessage(cause instanceof MarketplaceClientError && cause.code === 'update_conflict'
        ? '合集已在别处更新，请重新打开后再试。'
        : cause instanceof Error ? cause.message : '合集更新失败。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="preset-manager" aria-label="管理预设合集">
      <h3>管理合集</h3>
      <form onSubmit={(event) => void save(event)}>
        <label>
          标题
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
          {errors.title && <small className="preset-manager__error">{errors.title}</small>}
        </label>
        <label>
          介绍
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <fieldset>
          <legend>标签（1–5）</legend>
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
          可见性
          <select value={visibility} onChange={(event) => setVisibility(
            event.target.value as 'public' | 'unlisted' | 'withdrawn'
          )}>
            <option value="public">Public</option>
            <option value="unlisted">Unlisted</option>
            <option value="withdrawn">撤回</option>
          </select>
        </label>
        <div className="preset-manager__section">
          <h4>固定修订条目</h4>
          <small>编辑 revision id 即显式升级；保存后不会跟随原作品自动变化。</small>
          <ol className="collection-manager__items">
            {items.map((item, index) => (
              <li key={`${index}-${item.presetId}-${item.revisionId}`}>
                <input
                  aria-label={`条目 ${index + 1} preset id`}
                  placeholder="preset id"
                  value={item.presetId}
                  onChange={(event) => updateItem(index, 'presetId', event.target.value)}
                />
                <input
                  aria-label={`条目 ${index + 1} revision id`}
                  placeholder="revision id"
                  value={item.revisionId}
                  onChange={(event) => updateItem(index, 'revisionId', event.target.value)}
                />
                <div className="preset-manager__buttons">
                  <button type="button" disabled={index === 0} onClick={() => move(index, -1)}>上移</button>
                  <button type="button" disabled={index === items.length - 1} onClick={() => move(index, 1)}>下移</button>
                  <button type="button" onClick={() => setItems((current) => current.filter((_, itemIndex) => itemIndex !== index))}>移除</button>
                </div>
              </li>
            ))}
          </ol>
          <button type="button" onClick={() => setItems((current) => [
            ...current,
            { presetId: '', revisionId: '' },
          ])}>添加固定修订</button>
          {itemError && <small className="preset-manager__error">{itemError}</small>}
        </div>
        <button type="submit" disabled={busy}>{busy ? '保存中…' : '保存合集'}</button>
      </form>
      {message && <p className="preset-manager__message" role="status">{message}</p>}
    </section>
  );
}
