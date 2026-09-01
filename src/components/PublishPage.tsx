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
  'new-work': ['New Tone', 'This Rig has no online source — it creates an independent Tone.'],
  'new-revision': ['Publish New Revision', 'This Rig comes from your own Tone and appends an immutable revision; it cannot be turned into another publish kind.'],
  remix: ['Publish Remix', 'This Rig comes from another creator; the fixed source and revision are kept permanently and cannot be removed.'],
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
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<string | null>(null);

  useEffect(() => {
    void marketplaceClient.listAvailableTags().then(setTags, (cause: unknown) => {
      setMessage(cause instanceof Error ? cause.message : 'Could not load the managed tags.');
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
      <h1>This device has no publishable Rig to resume</h1>
      <p>Publishing can only start explicitly from the current Pedalboard Rig. If the Magic Link is opened on another device, sign-in succeeds but the local Rig does not transfer across devices.</p>
      <button type="button" onClick={() => onNavigate('/')}>Open Pedalboard</button>
    </section>
  );
  if (session.status === 'loading') return <section className="publish-page"><p>Loading member identity…</p></section>;
  if (session.status !== 'authenticated') return (
    <section className="publish-page app-route-placeholder">
      <span className="marketplace-detail__eyebrow">Publish draft saved in this tab</span>
      <h1>Sign in to continue the preview</h1>
      <p>Opening the Magic Link in this browser returns here; nothing is submitted automatically.</p>
      <button type="button" onClick={() => onNavigate('/login?return=%2Fpublish')}>Sign in to continue</button>
    </section>
  );
  if (!session.member.readyForPublicAttribution) return (
    <section className="publish-page app-route-placeholder">
      <h1>Complete public attribution and the current terms</h1><p>Publishing publicly for the first time requires a handle, a display name, and the current community terms; your publish draft stays in this browser.</p>
      <button type="button" onClick={() => onNavigate('/settings?section=account')}>Open Account Settings</button>
    </section>
  );
  if (published) return (
    <section className="publish-page app-route-placeholder">
      <span className="marketplace-detail__eyebrow">Published successfully</span>
      <h1>{published.title}</h1><p>Your current Rig now points at revision {published.currentRevision.id}; further edits get the correct publish semantics.</p>
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
    setBusy(true); setMessage(''); setVerificationUrl(null); setRetryAt(null);
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
      if (cause instanceof MarketplaceClientError && cause.verificationUrl) setVerificationUrl(cause.verificationUrl);
      if (cause instanceof MarketplaceClientError && cause.retryAt) setRetryAt(cause.retryAt);
      setMessage(cause instanceof MarketplaceClientError && cause.fields
        ? Object.values(cause.fields).join('; ')
        : cause instanceof Error ? cause.message : 'Publish failed; the draft is kept.');
    } finally { setBusy(false); }
  };

  return (
    <section className="publish-page">
      <span className="marketplace-detail__eyebrow">Publish current Pedalboard Rig</span>
      <h1>{kind ? KIND_COPY[kind][0] : 'Publish'}</h1>
      <ol className="publish-page__steps">{['Compatibility', 'Source', 'Metadata', 'Visibility', 'Final preview'].map((label, index) => <li key={label} className={index === step ? 'active' : index < step ? 'done' : ''}>{label}</li>)}</ol>
      <div className="publish-page__panel">
        {step === 0 && <><h2>Compatibility and resources</h2>{analysis ? <><p>The current canonical Rig can be published losslessly.</p><p>{analysis.resourceDependencies.map((item) => item.kind === 'builtin' ? 'Built-in resources' : `TONE3000 tone ${item.toneId}${item.modelId ? ` / model ${item.modelId}` : ''}`).join(' · ')}</p></> : <p role="alert">The Rig contains a local NAM model, a custom Cab IR, unknown gear, or an unsupported schema — it cannot be published.</p>}</>}
        {step === 1 && kind && <><h2>{KIND_COPY[kind][0]}</h2><p>{KIND_COPY[kind][1]}</p>{draft.provenance && <p>Source: {draft.provenance.presetId} · fixed revision {draft.provenance.revisionId}</p>}</>}
        {step === 2 && (isRevision ? <><h2>Keep the work metadata</h2><p>A New Revision only appends a sound revision; title, description, and tags remain managed separately under My Tones → Manage.</p></> : <><h2>Tone metadata</h2><label>Title<input value={draft.title} onChange={(event) => update({ title: event.target.value })} /></label>{fieldErrors.title && <small role="alert">{fieldErrors.title}</small>}<label>Plain-text description<textarea value={draft.description} onChange={(event) => update({ description: event.target.value })} /></label>{fieldErrors.description && <small role="alert">{fieldErrors.description}</small>}<fieldset><legend>Managed tags (1–5)</legend>{tags.map((tag) => <label key={tag.id}><input type="checkbox" checked={draft.tagIds.includes(tag.id)} onChange={() => update({ tagIds: draft.tagIds.includes(tag.id) ? draft.tagIds.filter((id) => id !== tag.id) : draft.tagIds.length < 5 ? [...draft.tagIds, tag.id] : draft.tagIds })} />{tag.nameEn}</label>)}</fieldset>{fieldErrors.tagIds && <small role="alert">{fieldErrors.tagIds}</small>}</>)}
        {step === 3 && (isRevision ? <><h2>Keep the current visibility</h2><p>Appending a revision never silently changes the work's Public, Unlisted, or Withdrawn state.</p></> : <><h2>Choose visibility explicitly</h2><p>Neither option is preselected.</p><label><input type="radio" name="visibility" checked={draft.visibility === 'public'} onChange={() => update({ visibility: 'public' })} />Public · discoverable</label><label><input type="radio" name="visibility" checked={draft.visibility === 'unlisted'} onChange={() => update({ visibility: 'unlisted' })} />Unlisted · direct link only</label></>)}
        {step === 4 && <><h2>Final preview</h2><dl><div><dt>Action</dt><dd>{kind && KIND_COPY[kind][0]}</dd></div><div><dt>Pedals</dt><dd>{draft.rig.chain.map((item) => item.effectId).join(', ') || 'None'}</dd></div><div><dt>Amp / Cab</dt><dd>{draft.rig.amp.modelKey} / {draft.rig.cab.id}</dd></div>{!isRevision && <div><dt>Visibility</dt><dd>{draft.visibility}</dd></div>}</dl><label><input type="checkbox" checked={terms} onChange={(event) => setTerms(event.target.checked)} />I confirm the current preview, source attribution, visibility, and community terms</label></>}
      </div>
      {message && <p className="publish-dialog__error" role="alert">{message}</p>}
      {verificationUrl && <button type="button" onClick={() => onNavigate(verificationUrl)}>Verify email</button>}
      {retryAt && <p>Retry available after {new Date(retryAt).toLocaleString()}</p>}
      <div className="publish-page__actions"><button type="button" onClick={() => step === 0 ? onNavigate('/') : setStep((value) => value - 1)}>{step === 0 ? 'Cancel' : 'Back'}</button>{step < 4 ? <button type="button" disabled={!canContinue} onClick={() => setStep((value) => value + 1)}>Continue</button> : <button type="button" disabled={!canContinue || busy} onClick={() => void submit()}>{busy ? 'Publishing…' : kind && KIND_COPY[kind][0]}</button>}</div>
    </section>
  );
}
