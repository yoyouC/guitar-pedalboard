import { useEffect, useMemo, useState } from 'react';
import type { MarketplaceTag, PublishedPreset } from '../../shared/marketplace';
import { validatePublicationFields, validatePublishPresetRequest } from '../../shared/marketplacePublication';
import { analyzePublishableRig } from '../../shared/publishableRig';
import { marketplaceClient, MarketplaceClientError } from '../marketplace/client';
import { clearPublishDraft, loadPublishDraft, publicationKind, savePublishDraft, type PublishDraft } from '../marketplace/publishDraft';
import { publishRigFromLocalSource } from '../marketplace/publishRig';
import { useMemberSession } from '../members/useMemberSession';
import { RIG_PRESET_VERSION } from '../state/presetCodec';
import { rigStore } from '../state/useRig';

interface PublishPageProps { onNavigate(pathname: string): void }

const KIND_COPY = {
  'new-work': ['New Tone', '这份 Rig 没有线上来源，将创建独立 Tone。'],
  'new-revision': ['Publish New Revision', '这份 Rig 来自你自己的 Tone，将追加不可变修订；不能改成另一种发布方式。'],
  remix: ['Publish Remix', '这份 Rig 来自另一位 Creator；固定来源和 revision 会永久保留，不能移除。'],
} as const;

export function PublishPage({ onNavigate }: PublishPageProps) {
  const session = useMemberSession();
  const [draft, setDraft] = useState<PublishDraft | null>(loadPublishDraft);
  const [tags, setTags] = useState<MarketplaceTag[]>([]);
  const [step, setStep] = useState(0);
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [published, setPublished] = useState<PublishedPreset | null>(null);

  useEffect(() => {
    void marketplaceClient.listAvailableTags().then(setTags, (cause: unknown) => {
      setMessage(cause instanceof Error ? cause.message : '无法读取受控标签。');
    });
  }, []);
  useEffect(() => { if (draft) savePublishDraft(draft); }, [draft]);

  const memberId = session.status === 'authenticated' ? session.member.id : '';
  const kind = draft && memberId ? publicationKind(draft.provenance, memberId) : null;
  const analysis = useMemo(() => draft ? analyzePublishableRig(draft.rig) : null, [draft]);
  const fieldErrors = draft ? validatePublicationFields(draft) : {};
  const request = useMemo(() => draft ? validatePublishPresetRequest({
    title: draft.title,
    description: draft.description,
    tagIds: draft.tagIds,
    schemaVersion: RIG_PRESET_VERSION,
    rig: draft.rig,
    ...(draft.visibility ? { visibility: draft.visibility } : {}),
  }, new Set(tags.map((tag) => tag.id))) : { value: null, errors: {} }, [draft, tags]);

  if (!draft) return (
    <section className="publish-page app-route-placeholder" role="alert">
      <span className="marketplace-detail__eyebrow">Publish · Local browser boundary</span>
      <h1>这台设备没有可恢复的发布 Rig</h1>
      <p>发布只能从当前 Pedalboard Rig 显式开始。若 Magic Link 在另一台设备打开，登录会成功，但本地 Rig 不会跨设备传输。</p>
      <button type="button" onClick={() => onNavigate('/')}>Open Pedalboard</button>
    </section>
  );
  if (session.status === 'loading') return <section className="publish-page"><p>正在读取成员身份…</p></section>;
  if (session.status !== 'authenticated') return (
    <section className="publish-page app-route-placeholder">
      <span className="marketplace-detail__eyebrow">Publish draft saved in this tab</span>
      <h1>登录后继续预览</h1>
      <p>Magic Link 在同一浏览器打开后会回到这里；系统不会自动提交。</p>
      <button type="button" onClick={() => onNavigate('/login?return=%2Fpublish')}>Sign in to continue</button>
    </section>
  );
  if (!session.member.readyForPublicAttribution) return (
    <section className="publish-page app-route-placeholder">
      <h1>完成公开署名与当前条款</h1><p>首次公开创作前需要 handle、display name 与当前社区条款；你的发布草稿仍保留在此浏览器。</p>
      <button type="button" onClick={() => onNavigate('/settings?section=account')}>Open Account Settings</button>
    </section>
  );
  if (published) return (
    <section className="publish-page app-route-placeholder">
      <span className="marketplace-detail__eyebrow">Published successfully</span>
      <h1>{published.title}</h1><p>当前 Rig 已指向 revision {published.currentRevision.id}，继续编辑时会得到正确的发布语义。</p>
      <button type="button" onClick={() => onNavigate('/')}>Continue editing</button>
      <button type="button" onClick={() => onNavigate(`/marketplace/tones/${encodeURIComponent(published.id)}`)}>Open public Tone</button>
    </section>
  );

  const isRevision = kind === 'new-revision';
  const canContinue = step === 0 ? Boolean(analysis)
    : step === 1 ? true
      : step === 2 ? isRevision || Object.keys(fieldErrors).length === 0
        : step === 3 ? isRevision || draft.visibility !== null
          : terms && (isRevision || Boolean(request.value)) && Boolean(analysis);
  const update = (patch: Partial<PublishDraft>) => setDraft((current) => current ? { ...current, ...patch } : current);
  const submit = async () => {
    if (!kind || !analysis || !canContinue) return;
    setBusy(true); setMessage('');
    try {
      const baseRequest = isRevision ? {
        title: '', description: '', tagIds: [], schemaVersion: RIG_PRESET_VERSION, rig: draft.rig,
      } : request.value!.request;
      const result = await publishRigFromLocalSource({ client: marketplaceClient, currentMemberId: memberId, request: baseRequest, provenance: draft.provenance });
      rigStore.recordPublishedProvenance({
        presetId: result.preset.id,
        revisionId: result.preset.currentRevision.id,
        creatorId: result.preset.creator.id,
        presetUpdatedAt: result.preset.updatedAt,
      });
      clearPublishDraft();
      setPublished(result.preset);
    } catch (cause) {
      setMessage(cause instanceof MarketplaceClientError && cause.fields
        ? Object.values(cause.fields).join('；')
        : cause instanceof Error ? cause.message : '发布失败；草稿仍保留。');
    } finally { setBusy(false); }
  };

  return (
    <section className="publish-page">
      <span className="marketplace-detail__eyebrow">Publish current Pedalboard Rig</span>
      <h1>{kind ? KIND_COPY[kind][0] : 'Publish'}</h1>
      <ol className="publish-page__steps">{['兼容性', '来源', '元数据', '可见性', '最终预览'].map((label, index) => <li key={label} className={index === step ? 'active' : index < step ? 'done' : ''}>{label}</li>)}</ol>
      <div className="publish-page__panel">
        {step === 0 && <><h2>兼容性与资源</h2>{analysis ? <><p>✓ 当前 canonical Rig 可无损发布。</p><p>{analysis.resourceDependencies.map((item) => item.kind === 'builtin' ? 'Built-in resources' : `TONE3000 tone ${item.toneId}${item.modelId ? ` / model ${item.modelId}` : ''}`).join(' · ')}</p></> : <p role="alert">Rig 包含 local NAM、Custom Cab IR、未知设备或不受支持 schema，不能发布。</p>}</>}
        {step === 1 && kind && <><h2>{KIND_COPY[kind][0]}</h2><p>{KIND_COPY[kind][1]}</p>{draft.provenance && <p>Source: {draft.provenance.presetId} · fixed revision {draft.provenance.revisionId}</p>}</>}
        {step === 2 && (isRevision ? <><h2>保留作品元数据</h2><p>New Revision 只追加声音修订；标题、介绍和标签继续由 My Tones Manage 独立管理。</p></> : <><h2>Tone 元数据</h2><label>标题<input value={draft.title} onChange={(event) => update({ title: event.target.value })} /></label>{fieldErrors.title && <small role="alert">{fieldErrors.title}</small>}<label>纯文本介绍<textarea value={draft.description} onChange={(event) => update({ description: event.target.value })} /></label>{fieldErrors.description && <small role="alert">{fieldErrors.description}</small>}<fieldset><legend>受控标签（1–5 个）</legend>{tags.map((tag) => <label key={tag.id}><input type="checkbox" checked={draft.tagIds.includes(tag.id)} onChange={() => update({ tagIds: draft.tagIds.includes(tag.id) ? draft.tagIds.filter((id) => id !== tag.id) : draft.tagIds.length < 5 ? [...draft.tagIds, tag.id] : draft.tagIds })} />{tag.nameZh} / {tag.nameEn}</label>)}</fieldset>{fieldErrors.tagIds && <small role="alert">{fieldErrors.tagIds}</small>}</>)}
        {step === 3 && (isRevision ? <><h2>保留当前作品可见性</h2><p>追加 revision 不会暗中改变作品的 Public、Unlisted 或 Withdrawn 状态。</p></> : <><h2>明确选择可见性</h2><p>两项都不会预选。</p><label><input type="radio" name="visibility" checked={draft.visibility === 'public'} onChange={() => update({ visibility: 'public' })} />Public · 可进入发现</label><label><input type="radio" name="visibility" checked={draft.visibility === 'unlisted'} onChange={() => update({ visibility: 'unlisted' })} />Unlisted · 仅直接链接</label></>)}
        {step === 4 && <><h2>最终预览</h2><dl><div><dt>Action</dt><dd>{kind && KIND_COPY[kind][0]}</dd></div><div><dt>Pedals</dt><dd>{draft.rig.chain.map((item) => item.effectId).join('、') || 'None'}</dd></div><div><dt>Amp / Cab</dt><dd>{draft.rig.amp.modelKey} / {draft.rig.cab.id}</dd></div>{!isRevision && <div><dt>Visibility</dt><dd>{draft.visibility}</dd></div>}</dl><label><input type="checkbox" checked={terms} onChange={(event) => setTerms(event.target.checked)} />我确认当前预览、来源署名、可见性和社区条款</label></>}
      </div>
      {message && <p className="publish-dialog__error" role="alert">{message}</p>}
      <div className="publish-page__actions"><button type="button" onClick={() => step === 0 ? onNavigate('/') : setStep((value) => value - 1)}>{step === 0 ? 'Cancel' : 'Back'}</button>{step < 4 ? <button type="button" disabled={!canContinue} onClick={() => setStep((value) => value + 1)}>Continue</button> : <button type="button" disabled={!canContinue || busy} onClick={() => void submit()}>{busy ? 'Publishing…' : kind && KIND_COPY[kind][0]}</button>}</div>
    </section>
  );
}
