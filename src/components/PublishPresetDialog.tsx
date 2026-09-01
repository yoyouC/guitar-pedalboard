import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { MarketplaceTag, PublishedPreset } from '../../shared/marketplace.ts';
import type { RigPresetState, RigProvenance } from '../state/presetCodec.ts';
import { RIG_PRESET_VERSION } from '../state/presetCodec.ts';
import {
  validatePublicationFields,
  validatePublishPresetRequest,
} from '../../shared/marketplacePublication.ts';
import { marketplaceClient, MarketplaceClientError } from '../marketplace/client.ts';
import { useMemberSession } from '../members/useMemberSession.ts';
import { publishRigFromLocalSource } from '../marketplace/publishRig.ts';
import { analyzePublishableRig } from '../../shared/publishableRig.ts';

interface PublishPresetDialogProps {
  rig: RigPresetState;
  sourceLabel: string;
  initialTitle: string;
  provenance: RigProvenance | null;
  onClose(): void;
  onNavigate(pathname: string): void;
  onPublished(pathname: string, preset: PublishedPreset): void;
}

export function PublishPresetDialog({
  rig,
  sourceLabel,
  initialTitle,
  provenance,
  onClose,
  onNavigate,
  onPublished,
}: PublishPresetDialogProps) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [tags, setTags] = useState<MarketplaceTag[]>([]);
  const [message, setMessage] = useState('');
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const session = useMemberSession();
  const currentMemberId = session.status === 'authenticated' ? session.member.id : null;

  useEffect(() => {
    let active = true;
    void marketplaceClient.listAvailableTags().then(
      (next) => { if (active) setTags(next); },
      (cause: unknown) => {
        if (active) setMessage(cause instanceof Error ? cause.message : 'Could not load tags');
      },
    );
    return () => { active = false; };
  }, []);

  const appendsOwnWork = Boolean(
    provenance && currentMemberId && provenance.creatorId === currentMemberId,
  );
  const soundAnalysis = useMemo(() => analyzePublishableRig(rig), [rig]);

  const errors = useMemo(() => validatePublicationFields({ title, description, tagIds }), [
    title,
    description,
    tagIds,
  ]);
  const preview = useMemo(() => validatePublishPresetRequest({
    title,
    description,
    tagIds,
    schemaVersion: RIG_PRESET_VERSION,
    rig,
    ...(provenance ? {
      source: { presetId: provenance.presetId, revisionId: provenance.revisionId },
    } : {}),
  }, new Set(tags.map((tag) => tag.id))), [title, description, tagIds, rig, tags, provenance]);

  const toggleTag = (tagId: string) => {
    setTagIds((current) => current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : current.length < 5 ? [...current, tagId] : current);
  };

  const publish = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !currentMemberId
      || !soundAnalysis
      || (!appendsOwnWork && !preview.value)
    ) return;
    setBusy(true);
    setMessage('');
    setVerificationUrl(null);
    setRetryAt(null);
    try {
      const request = preview.value?.request ?? {
        title: '',
        description: '',
        tagIds: [],
        schemaVersion: RIG_PRESET_VERSION,
        rig,
      };
      const { preset } = await publishRigFromLocalSource({
        client: marketplaceClient,
        currentMemberId,
        request,
        provenance,
      });
      onPublished(`/marketplace/tones/${encodeURIComponent(preset.id)}`, preset);
    } catch (cause) {
      if (cause instanceof MarketplaceClientError && cause.verificationUrl) {
        setVerificationUrl(cause.verificationUrl);
      }
      if (cause instanceof MarketplaceClientError && cause.retryAt) setRetryAt(cause.retryAt);
      if (cause instanceof MarketplaceClientError && cause.fields) {
        setMessage(Object.values(cause.fields).join('；'));
      } else {
        setMessage(cause instanceof Error ? cause.message : 'Publish failed');
      }
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="publish-dialog__backdrop" role="presentation">
      <section className="publish-dialog" role="dialog" aria-modal="true" aria-label="Publish preview">
        <div className="publish-dialog__header">
          <div><small>Publish preview · {sourceLabel}</small><h2>Publish to Tone Market</h2></div>
          <button type="button" onClick={onClose} aria-label="Close publish preview">×</button>
        </div>
        <form onSubmit={publish}>
          {appendsOwnWork && (
            <p>This Rig comes from your own work; confirming appends an immutable new revision.</p>
          )}
          {!appendsOwnWork && <>
          <label>Title<input required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          {errors.title && <small className="publish-dialog__error">{errors.title}</small>}
          <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          {errors.description && <small className="publish-dialog__error">{errors.description}</small>}
          <fieldset>
            <legend>Managed tags (1–5)</legend>
            <div className="publish-dialog__tags">
              {tags.map((tag) => (
                <label key={tag.id}>
                  <input type="checkbox" checked={tagIds.includes(tag.id)} onChange={() => toggleTag(tag.id)} />
                  {tag.nameZh} / {tag.nameEn}
                </label>
              ))}
            </div>
          </fieldset>
          {errors.tagIds && <small className="publish-dialog__error">{errors.tagIds}</small>}
          </>}
          <dl className="publish-dialog__preview">
            <div><dt>Pedals</dt><dd>{rig.chain.map((item) => item.effectId).join('、') || 'None'}</dd></div>
            <div><dt>Amp</dt><dd>{rig.amp.modelKey}</dd></div>
            <div><dt>Cab</dt><dd>{rig.cab.id}</dd></div>
            <div><dt>Resources</dt><dd>{soundAnalysis?.resourceDependencies.map((item) => item.kind === 'builtin' ? 'Built-in' : `TONE3000 ${item.toneId}`).join('、') ?? errors.rig ?? 'The Rig cannot be published losslessly or contains local resources'}</dd></div>
          </dl>
          {message && <p className="publish-dialog__error" role="alert">{message}</p>}
          {verificationUrl && (
            <button type="button" onClick={() => { onClose(); onNavigate(verificationUrl); }}>
              Verify email
            </button>
          )}
          {retryAt && <p>Retry available after {new Date(retryAt).toLocaleString()}</p>}
          <div className="publish-dialog__actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" disabled={busy || !currentMemberId || !soundAnalysis || (!appendsOwnWork && !preview.value)}>
              {busy ? 'Publishing…' : appendsOwnWork ? 'Append new revision' : 'Confirm publish'}
            </button>
          </div>
        </form>
      </section>
    </div>,
    document.body,
  );
}
