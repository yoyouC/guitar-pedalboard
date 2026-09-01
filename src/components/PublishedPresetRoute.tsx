import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Loader2,
  XCircle,
} from 'lucide-react';
import type {
  PublishedPresetRevisionCompatibility,
  PublishedPreset,
  PublishedPresetRevision,
  PublishedPresetRevisionSummary,
  PublishedPresetRevisionView,
  RigDerivedAttributes,
  RigResourceDependency,
} from '../../shared/marketplace';
import { MarketplaceClientError, marketplaceClient } from '../marketplace/client';
import {
  compatibilityBlockerMessage,
  resolvePublishedRevisionCompatibility,
} from '../marketplace/revisionCompatibility';
import { browserTone3000Compatibility } from '../marketplace/revisionCompatibilityBrowser';
import { browserPedalboardCapability } from '../marketplace/pedalboardCapability';
import {
  peekMarketplaceToneApplyIntent,
  popMarketplaceToneApplyIntent,
  stashMarketplaceToneApplyIntent,
} from '../marketplace/marketplaceToneIntent';
import { repairProvenanceFromPublishedPreset } from '../marketplace/publishRig';
import { useMarketplacePageMetadata } from '../marketplace/pageMetadata';
import { publishedPresetRouteFromPath, tonePath, toneRevisionPath } from '../marketplace/route';
import { toneSession } from '../marketplace/toneSession';
import { collectionQueue } from '../marketplace/collectionQueueSession';
import { loginTone3000 } from '../tone3000/instance';
import { encodeShareState } from '../state/share';
import { rigToShareState } from '../state/rigStore';
import { rigStore } from '../state/useRig';
import { EFFECT_REGISTRY } from '../audio/effects';
import { AMP_REGISTRY } from '../audio/amps';
import { AddToCollectionDialog } from './AddToCollectionDialog';
import { PublishedPresetManager } from './PublishedPresetManager';
import { MarketplaceLikeButton } from './MarketplaceLikeButton';
import { MarketplaceReportForm } from './MarketplaceReportForm';
import { ShareLinkFallback } from './ShareLinkFallback';
import { MiniRigChain } from './marketplace-ui/MiniRigChain.tsx';
import { TagBadge } from './marketplace-ui/TagBadge.tsx';
import { hueFromString } from './marketplace-ui/hash.ts';

interface DisplayedPreset {
  id: string;
  title: string;
  description: string;
  visibility: 'public' | 'unlisted' | 'withdrawn';
  creator: PublishedPreset['creator'];
  tags: PublishedPreset['tags'];
  revision: PublishedPresetRevision;
  derivedAttributes: RigDerivedAttributes;
  currentRevisionId: string;
  updatedAt: string;
  source: PublishedPreset['source'];
  fixedRevision: boolean;
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; displayed: DisplayedPreset; managedPreset: PublishedPreset | null }
  | { status: 'error'; kind: 'not-found' | 'unavailable'; message: string };

type CompatibilityState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'error'; message: string }
  | { status: 'ready'; value: PublishedPresetRevisionCompatibility };

function currentDisplay(preset: PublishedPreset): DisplayedPreset {
  return {
    id: preset.id,
    title: preset.title,
    description: preset.description,
    visibility: preset.visibility === 'hidden' ? 'withdrawn' : preset.visibility,
    creator: preset.creator,
    tags: preset.tags,
    revision: preset.currentRevision,
    derivedAttributes: preset.derivedAttributes,
    currentRevisionId: preset.currentRevision.id,
    updatedAt: preset.updatedAt,
    source: preset.source,
    fixedRevision: false,
  };
}

function revisionDisplay(preset: PublishedPresetRevisionView): DisplayedPreset {
  return {
    id: preset.id,
    title: preset.title,
    description: preset.description,
    visibility: preset.visibility,
    creator: preset.creator,
    tags: preset.tags,
    revision: preset.revision,
    derivedAttributes: preset.revision.derivedAttributes,
    currentRevisionId: preset.currentRevisionId,
    updatedAt: preset.updatedAt,
    source: preset.source,
    fixedRevision: true,
  };
}

function dependencyLabel(dependency: RigResourceDependency): string {
  if (dependency.kind === 'builtin') return 'Built-in resources';
  return `TONE3000 tone ${dependency.toneId}${dependency.modelId ? ` / model ${dependency.modelId}` : ''}`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function pedalName(id: string): string {
  return EFFECT_REGISTRY.find((def) => def.id === id)?.name ?? id;
}

function ampName(id: string): string {
  return AMP_REGISTRY.find((def) => def.id === id)?.name ?? id;
}

function initials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts.slice(0, 2).map((part) => part[0]).join('');
}

const COMPATIBILITY_PRESENTATION = {
  compatible: { icon: CheckCircle2, label: 'Fully compatible' },
  'authorization-required': { icon: AlertTriangle, label: 'TONE3000 authorization required' },
  incompatible: { icon: XCircle, label: 'Cannot be applied faithfully' },
} as const;

export interface PublishedPresetRouteProps {
  pathname: string;
  onClose(): void;
  onNavigate(pathname: string): void;
}

export function PublishedPresetRoute({ pathname, onClose, onNavigate }: PublishedPresetRouteProps) {
  const route = publishedPresetRouteFromPath(pathname);
  const presetId = route?.presetId ?? null;
  const revisionId = route?.revisionId ?? null;
  const [attempt, setAttempt] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ status: 'idle' });
  const [actionMessage, setActionMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [showCollectionDialog, setShowCollectionDialog] = useState(false);
  const [compatibility, setCompatibility] = useState<CompatibilityState>({ status: 'idle' });
  const [revisions, setRevisions] = useState<PublishedPresetRevisionSummary[] | null>(null);
  const capability = useMemo(browserPedalboardCapability, []);
  const compactViewport = useMemo(() => window.matchMedia('(max-width: 720px)').matches, []);
  const resumedIntentRef = useRef('');

  const applyToPedalboard = useCallback(async (displayed: DisplayedPreset) => {
    setBusy(true);
    const result = await toneSession.apply({
      id: displayed.id,
      title: displayed.title,
      creator: displayed.creator,
      updatedAt: displayed.updatedAt,
      currentRevision: displayed.revision,
    });
    setBusy(false);
    if (result.ok) {
      collectionQueue.clear();
      onNavigate('/');
    } else setActionMessage(result.message ?? 'Apply failed.');
  }, [onNavigate]);

  useEffect(() => {
    if (!presetId) return;
    let active = true;
    setLoadState({ status: 'loading' });
    setActionMessage('');

    const load = async () => {
      if (revisionId) {
        const revision = await marketplaceClient.getPublishedPresetRevision(
          presetId,
          revisionId,
        );
        return { displayed: revisionDisplay(revision), managedPreset: null };
      }

      const [visibleResult, managedResult] = await Promise.allSettled([
        marketplaceClient.getPublishedPreset(presetId),
        marketplaceClient.getManagedPublishedPreset(presetId),
      ]);
      const managedPreset = managedResult.status === 'fulfilled' ? managedResult.value : null;
      if (visibleResult.status === 'fulfilled') {
        return {
          displayed: currentDisplay(managedPreset ?? visibleResult.value),
          managedPreset,
        };
      }
      if (managedPreset) return { displayed: currentDisplay(managedPreset), managedPreset };
      throw visibleResult.reason;
    };

    void load().then(
      (ready) => {
        if (active) setLoadState({ status: 'ready', ...ready });
      },
      (error: unknown) => {
        if (active) {
          setLoadState({
            status: 'error',
            kind: error instanceof MarketplaceClientError && error.code === 'not_found'
              ? 'not-found'
              : 'unavailable',
            message: error instanceof Error ? error.message : 'Tone Market is unavailable.',
          });
        }
      },
    );
    return () => { active = false; };
  }, [presetId, revisionId, attempt]);

  useEffect(() => {
    if (loadState.status !== 'ready') return;
    let active = true;
    setCompatibility({ status: 'checking' });
    void resolvePublishedRevisionCompatibility(
      loadState.displayed.revision,
      browserTone3000Compatibility,
    ).then((value) => {
      if (active) setCompatibility({ status: 'ready', value });
    }, (cause: unknown) => {
      if (active) setCompatibility({
        status: 'error',
        message: cause instanceof Error ? cause.message : 'Compatibility check is unavailable.',
      });
    });
    return () => { active = false; };
  }, [loadState]);

  // Revision history for the Revisions section: additive read-only fetch; the
  // section simply stays hidden if the list cannot be loaded.
  useEffect(() => {
    if (loadState.status !== 'ready') return;
    if (loadState.displayed.visibility === 'withdrawn') {
      setRevisions(null);
      return;
    }
    let active = true;
    void marketplaceClient.listPublishedPresetRevisions(loadState.displayed.id).then(
      (list) => { if (active) setRevisions(list); },
      () => { if (active) setRevisions(null); },
    );
    return () => { active = false; };
  }, [loadState]);

  useEffect(() => {
    if (loadState.status !== 'ready' || compatibility.status !== 'ready') return;
    const intent = peekMarketplaceToneApplyIntent(window.localStorage);
    if (!intent
      || intent.presetId !== loadState.displayed.id
      || intent.revisionId !== loadState.displayed.revision.id) return;
    const key = `${intent.presetId}:${intent.revisionId}`;
    if (resumedIntentRef.current === key || !browserTone3000Compatibility.isAuthenticated()) return;
    resumedIntentRef.current = key;
    if (compatibility.value.status === 'compatible' && capability.supported) {
      popMarketplaceToneApplyIntent(window.localStorage);
      void applyToPedalboard(loadState.displayed);
    } else if (compatibility.value.status === 'incompatible') {
      popMarketplaceToneApplyIntent(window.localStorage);
    }
  }, [applyToPedalboard, capability.supported, compatibility, loadState]);

  useMarketplacePageMetadata(loadState.status === 'ready' ? {
    kind: 'preset',
    id: loadState.displayed.id,
    revisionId: loadState.displayed.fixedRevision ? loadState.displayed.revision.id : null,
    title: loadState.displayed.title,
    description: loadState.displayed.description,
    visibility: loadState.displayed.visibility,
  } : null);

  if (!route) return null;

  const connectAndContinue = async (displayed: DisplayedPreset) => {
    const intent = {
      presetId: displayed.id,
      revisionId: displayed.revision.id,
      returnPath: pathname.replace(/\/$/, '') || '/',
    };
    stashMarketplaceToneApplyIntent(intent, window.localStorage);
    setBusy(true);
    let redirecting = false;
    const authenticated = await loginTone3000(
      () => encodeShareState(rigToShareState(rigStore.getState())),
      () => { redirecting = true; },
    );
    if (!authenticated) {
      setBusy(false);
      if (!redirecting) {
        popMarketplaceToneApplyIntent(window.localStorage);
        setActionMessage('TONE3000 connection did not complete; your current Rig is unchanged.');
      }
      return;
    }
    const next = await resolvePublishedRevisionCompatibility(
      displayed.revision,
      browserTone3000Compatibility,
    );
    setCompatibility({ status: 'ready', value: next });
    if (next.status === 'compatible' && capability.supported) {
      popMarketplaceToneApplyIntent(window.localStorage);
      await applyToPedalboard(displayed);
    } else {
      popMarketplaceToneApplyIntent(window.localStorage);
      setBusy(false);
      setActionMessage('Connection completed, but blockers remain — no partial Rig was applied.');
    }
  };

  const beginManualRepair = (displayed: DisplayedPreset) => {
    rigStore.recordPublishedProvenance(repairProvenanceFromPublishedPreset({
      id: displayed.id,
      title: displayed.title,
      description: displayed.description,
      visibility: displayed.visibility === 'withdrawn' ? 'unlisted' : displayed.visibility,
      creator: displayed.creator,
      tags: displayed.tags,
      revision: displayed.revision,
      currentRevisionId: displayed.currentRevisionId,
      createdAt: displayed.revision.createdAt,
      updatedAt: displayed.updatedAt,
      ...(displayed.source ? { source: displayed.source } : {}),
    }));
    onNavigate('/');
  };

  return (
    <section className="mk-detail" aria-live="polite">
      {loadState.status === 'loading' || loadState.status === 'idle' ? (
        <div className="mk-detail__skeleton" aria-hidden="true">
          <div className="mk-skeleton" style={{ aspectRatio: '21 / 9', borderRadius: 14 }} />
          <div className="mk-skeleton" style={{ height: 30, width: '45%' }} />
          <div className="mk-skeleton" style={{ height: 14, width: '30%' }} />
          <div className="mk-skeleton" style={{ height: 60, width: '70%' }} />
        </div>
      ) : loadState.status === 'error' ? (
        <div className="mk-detail__error" role="alert">
          <strong>{loadState.kind === 'not-found' ? 'Tone Not Found' : 'Tone Market is unavailable'}</strong>
          <p>{loadState.message}</p>
          <div>
            <button type="button" className="mk-btn mk-btn--secondary" onClick={() => setAttempt((value) => value + 1)}>Retry</button>
          </div>
          <small>Your local Rig, presets, snapshots, sharing, and audio below are unaffected.</small>
        </div>
      ) : (
        <>
          <header className="mk-detail__head">
            <div className="mk-detail__topline">
              <span className="mk-detail__eyebrow">Tone Market · Tone</span>
              <button type="button" className="mk-btn mk-btn--ghost" onClick={onClose}>
                <ArrowLeft size={15} aria-hidden="true" />
                Back to pedalboard
              </button>
            </div>
            <div className="mk-card mk-detail__hero">
              <MiniRigChain
                pedalIds={loadState.displayed.derivedAttributes.pedalIds}
                ampId={loadState.displayed.derivedAttributes.ampId}
                seed={loadState.displayed.id}
                hero
              />
            </div>
            <h1 className="mk-detail__title">{loadState.displayed.title}</h1>
            <button
              type="button"
              className="mk-detail__creator"
              onClick={() => onNavigate(
                `/creators/id/${encodeURIComponent(loadState.displayed.creator.id)}`,
              )}
            >
              <span
                className="mk-avatar"
                style={{ '--mk-avatar-hue': hueFromString(loadState.displayed.creator.handle) } as CSSProperties}
                aria-hidden="true"
              >
                {initials(loadState.displayed.creator.displayName)}
              </span>
              <span className="mk-detail__creator-name">{loadState.displayed.creator.displayName}</span>
              <span className="mk-detail__creator-handle">@{loadState.displayed.creator.handle}</span>
            </button>
            <p className="mk-detail__meta">
              Updated {formatDate(loadState.displayed.updatedAt)} · revision {loadState.displayed.revision.id}
              {loadState.displayed.fixedRevision ? ' · fixed permalink' : ''}
            </p>
          </header>

          <div className="mk-detail__columns">
            <div className="mk-detail__main">
              {loadState.displayed.visibility === 'unlisted' && (
                <p className="mk-notice">Unlisted — only people with the direct link can open this tone. It does not appear in public discovery.</p>
              )}
              {loadState.displayed.visibility === 'withdrawn' && (
                <p className="mk-notice">This tone has been withdrawn. Only the author can restore it here.</p>
              )}
              {loadState.displayed.fixedRevision && (
                <p className="mk-notice">
                  This is a fixed-revision permalink — it does not follow the current sound.
                  {loadState.displayed.revision.id !== loadState.displayed.currentRevisionId && (
                    <button type="button" onClick={() => onNavigate(
                      tonePath(loadState.displayed.id)
                    )}>View current revision</button>
                  )}
                </p>
              )}

              <p className="mk-detail__description">
                {loadState.displayed.description || 'No description provided.'}
              </p>

              <section className="mk-detail__section" aria-label="Signal chain">
                <h2 className="mk-detail__section-title">Signal chain</h2>
                <div className="mk-chain-flow">
                  {loadState.displayed.derivedAttributes.pedalIds.length === 0 && (
                    <span className="mk-chain-flow__item mk-chain-flow__item--muted">No pedals</span>
                  )}
                  {loadState.displayed.derivedAttributes.pedalIds.map((pedalId, index) => (
                    <span key={`${pedalId}-${index}`} className="mk-chain-flow__group">
                      <span className="mk-chain-flow__item">{pedalName(pedalId)}</span>
                      <ChevronRight className="mk-chain-flow__sep" size={13} aria-hidden="true" />
                    </span>
                  ))}
                  <span className="mk-chain-flow__item">{ampName(loadState.displayed.derivedAttributes.ampId)}</span>
                  <ChevronRight className="mk-chain-flow__sep" size={13} aria-hidden="true" />
                  <span className="mk-chain-flow__item mk-chain-flow__item--muted">{loadState.displayed.derivedAttributes.cabId}</span>
                </div>
                <p className="mk-detail__resources">
                  Resources: {loadState.displayed.revision.resourceDependencies.map(dependencyLabel).join(' · ')}
                </p>
              </section>

              {loadState.displayed.tags.length > 0 && (
                <div className="mk-detail__tags">
                  {loadState.displayed.tags.map((tag) => <TagBadge key={tag.id} label={tag.nameEn} />)}
                </div>
              )}

              {loadState.displayed.revision.payloadKind === 'canonical-rig' && (
                <details className="mk-detail__rig">
                  <summary>Full Rig configuration</summary>
                  <h3>Pedal chain</h3>
                  {loadState.displayed.revision.rig.chain.length === 0 ? <p>No pedals.</p> : (
                    <ol>{loadState.displayed.revision.rig.chain.map((pedal, index) => (
                      <li key={`${pedal.effectId}-${index}`}>
                        <strong>{pedal.effectId}</strong> · {pedal.enabled ? 'On' : 'Bypassed'} · {pedal.post ? 'Post amp' : 'Pre amp'}
                        <small>{Object.entries(pedal.values).map(([key, value]) => `${key} ${value}`).join(' · ')}</small>
                      </li>
                    ))}</ol>
                  )}
                  <h3>Amp</h3>
                  <p>{loadState.displayed.revision.rig.amp.categoryId} / {loadState.displayed.revision.rig.amp.modelKey} · {loadState.displayed.revision.rig.amp.enabled ? 'On' : 'Bypassed'} · {Object.entries(loadState.displayed.revision.rig.amp.values).map(([key, value]) => `${key} ${value}`).join(' · ')}</p>
                  <h3>Cab</h3>
                  <p>{loadState.displayed.revision.rig.cab.id} · {loadState.displayed.revision.rig.cab.enabled ? 'On' : 'Bypassed'} · {Object.entries(loadState.displayed.revision.rig.cab.values).map(([key, value]) => `${key} ${value}`).join(' · ')}</p>
                  <h3>Global and pre-amp EQ</h3>
                  <p>Input {loadState.displayed.revision.rig.globals.inputGain} · Master {loadState.displayed.revision.rig.globals.masterVolume} · Global bypass {String(loadState.displayed.revision.rig.globals.bypass)} · EQ {loadState.displayed.revision.rig.preAmpEq.enabled ? 'On' : 'Off'}</p>
                </details>
              )}

              {revisions && revisions.length > 0 && (
                <section className="mk-detail__section" aria-label="Revisions">
                  <h2 className="mk-detail__section-title">Revisions</h2>
                  <ul className="mk-revision-list">
                    {revisions.map((revision) => (
                      <li key={revision.id}>
                        <button
                          type="button"
                          className="mk-revision-list__row"
                          aria-current={revision.id === loadState.displayed.revision.id || undefined}
                          onClick={() => onNavigate(
                            revision.id === loadState.displayed.currentRevisionId
                              ? tonePath(loadState.displayed.id)
                              : toneRevisionPath(loadState.displayed.id, revision.id),
                          )}
                        >
                          <span className="mk-revision-list__id">{revision.id}</span>
                          <span className="mk-revision-list__date">{formatDate(revision.createdAt)}</span>
                          {revision.isCurrent && <span className="mk-badge mk-badge--success">Current</span>}
                          {revision.id === loadState.displayed.revision.id
                            && loadState.displayed.fixedRevision
                            && !revision.isCurrent
                            && <span className="mk-badge mk-badge--warning">Viewing</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {(loadState.displayed.visibility === 'public'
                || loadState.displayed.visibility === 'unlisted') && (
                <div className="mk-detail__report">
                  <MarketplaceReportForm
                    kind="preset"
                    targetId={loadState.displayed.id}
                    onNavigate={onNavigate}
                  />
                </div>
              )}

              {loadState.managedPreset && !loadState.displayed.fixedRevision && (
                <PublishedPresetManager
                  preset={loadState.managedPreset}
                  onUpdated={(preset) => setLoadState({
                    status: 'ready',
                    displayed: currentDisplay(preset),
                    managedPreset: preset,
                  })}
                  onNavigate={onNavigate}
                />
              )}
            </div>

            <aside className="mk-detail__rail">
              <div className="mk-card mk-detail__panel">
                <section className="mk-compat" aria-label="Tone compatibility">
                  {compatibility.status === 'checking' || compatibility.status === 'idle' ? (
                    <p className="mk-compat__status" data-status="checking">
                      <Loader2 size={16} className="mk-spin" aria-hidden="true" />
                      Checking device, gear catalog, and external resources…
                    </p>
                  ) : compatibility.status === 'error' ? (
                    <p className="mk-compat__status" data-status="authorization-required">
                      <AlertTriangle size={16} aria-hidden="true" />
                      {compatibility.message} No Rig was applied.
                    </p>
                  ) : (() => {
                    const presentation = COMPATIBILITY_PRESENTATION[compatibility.value.status];
                    const StatusIcon = presentation.icon;
                    return (
                      <>
                        <p className="mk-compat__status" data-status={compatibility.value.status}>
                          <StatusIcon size={16} aria-hidden="true" />
                          {presentation.label}
                        </p>
                        {compatibility.value.blockers.length > 0 && (
                          <ul className="mk-compat__blockers">{compatibility.value.blockers.map((blocker, index) => (
                            <li key={`${blocker.kind}-${index}`}>{compatibilityBlockerMessage(blocker)}</li>
                          ))}</ul>
                        )}
                        {compatibility.value.status === 'incompatible' && (
                          <p className="mk-compat__hint">
                            The original revision stays viewable and untouched. Swap gear manually
                            from your current Rig, then publish the result as a new Revision or Remix.
                          </p>
                        )}
                      </>
                    );
                  })()}
                </section>

                {loadState.displayed.revision.resourceDependencies.some((item) => item.kind === 'tone3000') && (
                  <p className="mk-detail__rail-note">
                    This tone depends on TONE3000; if an external resource is unavailable you are
                    told explicitly — the original revision is never replaced.
                  </p>
                )}

                {loadState.displayed.visibility !== 'withdrawn' && (
                  <div className="mk-detail__actions">
                    {compatibility.status === 'ready' && compatibility.value.status === 'compatible' && (
                      <button type="button" className="mk-btn mk-btn--primary mk-btn--block" disabled={busy || !capability.supported} onClick={() => void applyToPedalboard(loadState.displayed)}>
                        {busy ? 'Applying…' : 'Use in Pedalboard'}
                      </button>
                    )}
                    {compatibility.status === 'ready' && compatibility.value.status === 'authorization-required' && (
                      <button type="button" className="mk-btn mk-btn--primary mk-btn--block" disabled={busy || !capability.supported} onClick={() => void connectAndContinue(loadState.displayed)}>
                        {busy ? 'Connecting…' : 'Connect & Continue'}
                      </button>
                    )}
                    {compatibility.status === 'ready' && compatibility.value.status === 'incompatible' && (
                      <button type="button" className="mk-btn mk-btn--secondary mk-btn--block" disabled={busy} onClick={() => beginManualRepair(loadState.displayed)}>
                        Start Manual Repair
                      </button>
                    )}
                    <button type="button" className="mk-btn mk-btn--secondary mk-btn--block" disabled={busy} onClick={() => setShowCollectionDialog(true)}>
                      Add to Collection
                    </button>
                    {actionMessage && <p className="mk-detail__action-message" role="status">{actionMessage}</p>}
                  </div>
                )}

                {!loadState.displayed.fixedRevision && loadState.displayed.visibility !== 'withdrawn' && (
                  <MarketplaceLikeButton kind="preset" targetId={loadState.displayed.id} targetCreatorId={loadState.displayed.creator.id} onNavigate={onNavigate} />
                )}

                {loadState.displayed.source && (
                  <p className="mk-detail__rail-note">
                    Remixed from{' '}
                    {loadState.displayed.source.availability === 'available' ? (
                      <button type="button" className="mk-detail__source-link" onClick={() => onNavigate(
                        toneRevisionPath(loadState.displayed.source!.presetId, loadState.displayed.source!.revisionId)
                      )}>
                        {loadState.displayed.source.title}
                      </button>
                    ) : 'a tone that is no longer available'}
                    {' '}by @{loadState.displayed.source.creator.handle}
                    {' '}· revision {loadState.displayed.source.revisionId}
                  </p>
                )}

                {!capability.supported && (
                  <div className="mk-detail__capability">
                    <strong>This browser does not support the Pedalboard audio runtime</strong>
                    <span>Missing: {capability.missing.join(', ')}. Use in Pedalboard is disabled.</span>
                    <ShareLinkFallback
                      pathname={toneRevisionPath(loadState.displayed.id, loadState.displayed.revision.id)}
                    />
                  </div>
                )}
                {capability.supported && compactViewport && (
                  <p className="mk-detail__rail-note">
                    This device has the required audio capabilities — you can continue. The full
                    Pedalboard control surface works best on desktop or a landscape tablet.
                  </p>
                )}
              </div>
            </aside>
          </div>

          {showCollectionDialog && (
            <AddToCollectionDialog
              tone={{
                presetId: loadState.displayed.id,
                revisionId: loadState.displayed.revision.id,
                title: loadState.displayed.title,
                creator: loadState.displayed.creator,
                visibility: loadState.displayed.visibility,
              }}
              onClose={() => setShowCollectionDialog(false)}
              onNavigate={onNavigate}
            />
          )}
        </>
      )}
    </section>
  );
}
