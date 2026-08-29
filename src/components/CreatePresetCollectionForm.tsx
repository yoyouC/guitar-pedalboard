import { useEffect, useState, type FormEvent } from 'react';
import type { MarketplaceTag } from '../../shared/marketplace';
import { validatePublicationFields, type PublicationErrors } from '../../shared/marketplacePublication';
import { MarketplaceClientError, marketplaceClient } from '../marketplace/client';

interface CreatePresetCollectionFormProps {
  onCreated(pathname: string): void;
  onCancel(): void;
}

export function CreatePresetCollectionForm({ onCreated, onCancel }: CreatePresetCollectionFormProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [visibility, setVisibility] = useState<'public' | 'unlisted'>('public');
  const [tags, setTags] = useState<MarketplaceTag[]>([]);
  const [errors, setErrors] = useState<PublicationErrors>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextErrors = validatePublicationFields({ title, description, tagIds });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setBusy(true);
    setMessage('');
    try {
      const collection = await marketplaceClient.createPresetCollection({
        title,
        description,
        tagIds,
        visibility,
      });
      onCreated(`/marketplace/collections/${encodeURIComponent(collection.id)}`);
    } catch (cause) {
      if (cause instanceof MarketplaceClientError && cause.fields) setErrors(cause.fields);
      setMessage(cause instanceof Error ? cause.message : '创建合集失败。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="collection-create" onSubmit={(event) => void submit(event)}>
      <h3>创建预设合集</h3>
      <label>
        标题
        <input value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} />
        {errors.title && <small className="preset-manager__error">{errors.title}</small>}
      </label>
      <label>
        介绍
        <textarea value={description} maxLength={2000} onChange={(event) => setDescription(event.target.value)} />
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
              {tag.nameZh}
            </label>
          ))}
        </div>
        {errors.tagIds && <small className="preset-manager__error">{errors.tagIds}</small>}
      </fieldset>
      <label>
        可见性
        <select value={visibility} onChange={(event) => setVisibility(
          event.target.value as 'public' | 'unlisted'
        )}>
          <option value="public">Public</option>
          <option value="unlisted">Unlisted</option>
        </select>
      </label>
      <div className="preset-manager__buttons">
        <button type="submit" disabled={busy}>{busy ? '创建中…' : '创建空合集'}</button>
        <button type="button" disabled={busy} onClick={onCancel}>取消</button>
      </div>
      {message && <p className="preset-manager__message">{message}</p>}
    </form>
  );
}
