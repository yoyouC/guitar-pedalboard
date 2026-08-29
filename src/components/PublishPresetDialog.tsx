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
  onPublished(pathname: string, preset: PublishedPreset): void;
}

export function PublishPresetDialog({
  rig,
  sourceLabel,
  initialTitle,
  provenance,
  onClose,
  onPublished,
}: PublishPresetDialogProps) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [tags, setTags] = useState<MarketplaceTag[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const session = useMemberSession();
  const currentMemberId = session.status === 'authenticated' ? session.member.id : null;

  useEffect(() => {
    let active = true;
    void marketplaceClient.listAvailableTags().then(
      (next) => { if (active) setTags(next); },
      (cause: unknown) => {
        if (active) setMessage(cause instanceof Error ? cause.message : '无法读取标签');
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
      if (cause instanceof MarketplaceClientError && cause.fields) {
        setMessage(Object.values(cause.fields).join('；'));
      } else {
        setMessage(cause instanceof Error ? cause.message : '发布失败');
      }
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="publish-dialog__backdrop" role="presentation">
      <section className="publish-dialog" role="dialog" aria-modal="true" aria-label="发布预览">
        <div className="publish-dialog__header">
          <div><small>发布预览 · {sourceLabel}</small><h2>发布到音色广场</h2></div>
          <button type="button" onClick={onClose} aria-label="关闭发布预览">×</button>
        </div>
        <form onSubmit={publish}>
          {appendsOwnWork && (
            <p>这份 Rig 来自你的作品；确认后会追加一个不可变的新修订。</p>
          )}
          {!appendsOwnWork && <>
          <label>标题<input required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          {errors.title && <small className="publish-dialog__error">{errors.title}</small>}
          <label>介绍<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          {errors.description && <small className="publish-dialog__error">{errors.description}</small>}
          <fieldset>
            <legend>受控标签（1–5 个）</legend>
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
            <div><dt>资源</dt><dd>{soundAnalysis?.resourceDependencies.map((item) => item.kind === 'builtin' ? '内置' : `TONE3000 ${item.toneId}`).join('、') ?? errors.rig ?? 'Rig 无法无损发布或包含本机资源'}</dd></div>
          </dl>
          {message && <p className="publish-dialog__error" role="alert">{message}</p>}
          <div className="publish-dialog__actions">
            <button type="button" onClick={onClose}>取消</button>
            <button type="submit" disabled={busy || !currentMemberId || !soundAnalysis || (!appendsOwnWork && !preview.value)}>
              {busy ? '发布中…' : appendsOwnWork ? '追加新修订' : '确认发布'}
            </button>
          </div>
        </form>
      </section>
    </div>,
    document.body,
  );
}
