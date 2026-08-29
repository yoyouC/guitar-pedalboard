import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  MarketplaceTag,
  PublishedPreset,
  PublishedPresetRevisionSummary,
  PublishedPresetVisibility,
} from '../../shared/marketplace';
import { validatePublicationFields, type PublicationErrors } from '../../shared/marketplacePublication';
import { RIG_PRESET_VERSION } from '../state/presetCodec';
import { rigToPresetState } from '../state/rigStore';
import { rigStore } from '../state/useRig';
import { MarketplaceClientError, marketplaceClient } from '../marketplace/client';
import {
  loadPublishedPresetManagerData,
  runPublishedPresetManagerMutation,
} from '../marketplace/publishedPresetManagerSession';

interface PublishedPresetManagerProps {
  preset: PublishedPreset;
  onUpdated(preset: PublishedPreset): void;
  onNavigate(pathname: string): void;
}

export function PublishedPresetManager({ preset, onUpdated, onNavigate }: PublishedPresetManagerProps) {
  const [title, setTitle] = useState(preset.title);
  const [description, setDescription] = useState(preset.description);
  const [tagIds, setTagIds] = useState(preset.tags.map((tag) => tag.id));
  const [tags, setTags] = useState<MarketplaceTag[]>([]);
  const [revisions, setRevisions] = useState<PublishedPresetRevisionSummary[]>([]);
  const [errors, setErrors] = useState<PublicationErrors>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const cancelOperationRef = useRef<() => void>(() => {});

  useEffect(() => {
    setTitle(preset.title);
    setDescription(preset.description);
    setTagIds(preset.tags.map((tag) => tag.id));
  }, [preset]);

  useEffect(() => {
    cancelOperationRef.current();
    cancelOperationRef.current = loadPublishedPresetManagerData(preset.id, marketplaceClient, {
      onLoaded: ({ tags: availableTags, revisions: history }) => {
        setTags(availableTags);
        setRevisions(history);
      },
      onError: (cause: unknown) => {
        setMessage(cause instanceof Error ? cause.message : '无法读取管理数据。');
      },
    });
    return () => {
      cancelOperationRef.current();
    };
  }, [preset.id]);

  const run = (operation: () => Promise<PublishedPreset>) => {
    cancelOperationRef.current();
    setBusy(true);
    setMessage('');
    setErrors({});
    cancelOperationRef.current = runPublishedPresetManagerMutation(
      preset.id,
      marketplaceClient,
      operation,
      {
        onUpdated,
        onLoaded: ({ tags: availableTags, revisions: history }) => {
          setTags(availableTags);
          setRevisions(history);
          setBusy(false);
          setMessage('作品已更新。');
        },
        onError: (cause) => {
          setBusy(false);
          if (cause instanceof MarketplaceClientError && cause.code === 'update_conflict') {
            setMessage('作品已在别处更新。请重新载入最新版本后再继续。');
          } else if (cause instanceof MarketplaceClientError && cause.fields) {
            setErrors(cause.fields);
            setMessage(cause.message);
          } else {
            setMessage(cause instanceof Error ? cause.message : '更新失败。');
          }
        },
      },
    );
  };

  const saveMetadata = (event: FormEvent) => {
    event.preventDefault();
    const nextErrors = validatePublicationFields({ title, description, tagIds });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    run(() => marketplaceClient.updatePublishedPresetMetadata(preset.id, {
      title,
      description,
      tagIds,
      expectedUpdatedAt: preset.updatedAt,
    }));
  };

  const appendCurrentRig = () => run(() => marketplaceClient.appendPublishedPresetRevision(
    preset.id,
    {
      schemaVersion: RIG_PRESET_VERSION,
      rig: rigToPresetState(rigStore.getState()),
      expectedUpdatedAt: preset.updatedAt,
    },
  ));

  const restore = (revisionId: string) => run(() => (
    marketplaceClient.restorePublishedPresetRevision(preset.id, revisionId, {
      expectedUpdatedAt: preset.updatedAt,
    })
  ));

  const setVisibility = (visibility: Exclude<PublishedPresetVisibility, 'hidden'>) => run(() => (
    marketplaceClient.updatePublishedPresetVisibility(preset.id, {
      visibility,
      expectedUpdatedAt: preset.updatedAt,
    })
  ));

  return (
    <section className="preset-manager" aria-label="管理广场预设">
      <h3>管理作品</h3>
      <form onSubmit={saveMetadata}>
        <label>
          标题
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
          {errors.title && <small className="preset-manager__error">{errors.title}</small>}
        </label>
        <label>
          介绍（纯文本）
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
          {errors.description && <small className="preset-manager__error">{errors.description}</small>}
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
          {errors.tagIds && <small className="preset-manager__error">{errors.tagIds}</small>}
        </fieldset>
        <button type="submit" disabled={busy}>保存展示信息</button>
      </form>

      <div className="preset-manager__section">
        <h4>声音修订</h4>
        <button type="button" disabled={busy} onClick={appendCurrentRig}>将当前 Rig 追加为新修订</button>
        <ol className="preset-manager__history">
          {revisions.map((revision) => (
            <li key={revision.id}>
              <span>{revision.id}{revision.isCurrent ? '（当前）' : ''}</span>
              <button type="button" onClick={() => onNavigate(
                `/marketplace/tones/${encodeURIComponent(preset.id)}/revisions/${encodeURIComponent(revision.id)}`
              )}>永久链接</button>
              {!revision.isCurrent && (
                <button type="button" disabled={busy} onClick={() => restore(revision.id)}>复制并回退</button>
              )}
            </li>
          ))}
        </ol>
      </div>

      <div className="preset-manager__section">
        <h4>可见性</h4>
        <p>当前：{preset.visibility}</p>
        <div className="preset-manager__buttons">
          <button type="button" disabled={busy || preset.visibility === 'public'} onClick={() => setVisibility('public')}>Public</button>
          <button type="button" disabled={busy || preset.visibility === 'unlisted'} onClick={() => setVisibility('unlisted')}>Unlisted</button>
          <button type="button" disabled={busy || preset.visibility === 'withdrawn'} onClick={() => setVisibility('withdrawn')}>撤回</button>
        </div>
      </div>

      {message && <p className="preset-manager__message" role="status">{message}</p>}
    </section>
  );
}
