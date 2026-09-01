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
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<string | null>(null);
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
        setMessage(cause instanceof Error ? cause.message : 'Could not load the management data.');
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
    setVerificationUrl(null);
    setRetryAt(null);
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
          setMessage('Work updated.');
        },
        onError: (cause) => {
          setBusy(false);
          if (cause instanceof MarketplaceClientError && cause.verificationUrl) {
            setVerificationUrl(cause.verificationUrl);
          }
          if (cause instanceof MarketplaceClientError && cause.retryAt) setRetryAt(cause.retryAt);
          if (cause instanceof MarketplaceClientError && cause.code === 'update_conflict') {
            setMessage('This work was updated elsewhere. Reload the latest version before continuing.');
          } else if (cause instanceof MarketplaceClientError && cause.fields) {
            setErrors(cause.fields);
            setMessage(cause.message);
          } else {
            setMessage(cause instanceof Error ? cause.message : 'Update failed.');
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
    <section className="preset-manager" aria-label="Manage marketplace tone">
      <h3>Manage work</h3>
      <form onSubmit={saveMetadata}>
        <label>
          Title
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
          {errors.title && <small className="preset-manager__error">{errors.title}</small>}
        </label>
        <label>
          Description (plain text)
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
          {errors.description && <small className="preset-manager__error">{errors.description}</small>}
        </label>
        <fieldset>
          <legend>Tags (1–5)</legend>
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
                {tag.nameEn}
              </label>
            ))}
          </div>
          {errors.tagIds && <small className="preset-manager__error">{errors.tagIds}</small>}
        </fieldset>
        <button type="submit" disabled={busy}>Save presentation</button>
      </form>

      <div className="preset-manager__section">
        <h4>Sound revisions</h4>
        <button type="button" disabled={busy} onClick={appendCurrentRig}>Append current Rig as a new revision</button>
        <ol className="preset-manager__history">
          {revisions.map((revision) => (
            <li key={revision.id}>
              <span>{revision.id}{revision.isCurrent ? ' (current)' : ''}</span>
              <button type="button" onClick={() => onNavigate(
                `/marketplace/tones/${encodeURIComponent(preset.id)}/revisions/${encodeURIComponent(revision.id)}`
              )}>Permalink</button>
              {!revision.isCurrent && (
                <button type="button" disabled={busy} onClick={() => restore(revision.id)}>Copy & roll back</button>
              )}
            </li>
          ))}
        </ol>
      </div>

      <div className="preset-manager__section">
        <h4>Visibility</h4>
        <p>Current: {preset.visibility}</p>
        <div className="preset-manager__buttons">
          <button type="button" disabled={busy || preset.visibility === 'public'} onClick={() => setVisibility('public')}>Public</button>
          <button type="button" disabled={busy || preset.visibility === 'unlisted'} onClick={() => setVisibility('unlisted')}>Unlisted</button>
          <button type="button" disabled={busy || preset.visibility === 'withdrawn'} onClick={() => setVisibility('withdrawn')}>Withdraw</button>
        </div>
      </div>

      {message && <p className="preset-manager__message" role="status">{message}</p>}
      {verificationUrl && (
        <button type="button" onClick={() => onNavigate(verificationUrl)}>Verify email</button>
      )}
      {retryAt && <p className="preset-manager__message">Retry available after {new Date(retryAt).toLocaleString()}</p>}
    </section>
  );
}
