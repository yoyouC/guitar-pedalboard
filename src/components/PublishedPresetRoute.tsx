import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  PublishedPresetRevisionCompatibility,
  PublishedPreset,
  PublishedPresetRevision,
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
import { AddToCollectionDialog } from './AddToCollectionDialog';
import { PublishedPresetManager } from './PublishedPresetManager';
import { MarketplaceLikeButton } from './MarketplaceLikeButton';
import { MarketplaceReportForm } from './MarketplaceReportForm';
import { ShareLinkFallback } from './ShareLinkFallback';

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
  if (dependency.kind === 'builtin') return '仅内置资源';
  return `TONE3000 tone ${dependency.toneId}${dependency.modelId ? ` / model ${dependency.modelId}` : ''}`;
}

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
    } else setActionMessage(result.message ?? '应用失败。');
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
            message: error instanceof Error ? error.message : '音色广场暂时不可用。',
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
        message: cause instanceof Error ? cause.message : '兼容性检查暂时不可用。',
      });
    });
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
        setActionMessage('TONE3000 连接未完成，当前 Rig 未改变。');
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
      setActionMessage('连接已完成，但仍有阻塞项；没有应用部分 Rig。');
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
    <section className="marketplace-detail" aria-live="polite">
      <div className="marketplace-detail__topline">
        <span className="marketplace-detail__eyebrow">Tone Market · Tone detail</span>
        <button className="marketplace-detail__close" type="button" onClick={onClose}>返回效果器</button>
      </div>

      {loadState.status === 'loading' || loadState.status === 'idle' ? (
        <p>正在读取音色…</p>
      ) : loadState.status === 'error' ? (
        <div className="marketplace-detail__error" role="alert">
          <strong>{loadState.kind === 'not-found' ? 'Tone Not Found' : 'Tone Market 暂时不可用'}</strong>
          <p>{loadState.message}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>重试</button>
          <small>下方本地 Rig、Preset、Snapshot、分享和音频功能不受影响。</small>
        </div>
      ) : (
        <div className="marketplace-detail__content">
          <div>
            <h2>{loadState.displayed.title}</h2>
            <p>{loadState.displayed.description || '作者没有填写介绍。'}</p>
            <p className="marketplace-detail__byline">
              @{loadState.displayed.creator.handle} · revision {loadState.displayed.revision.id}
            </p>
            {loadState.displayed.source && (
              <p className="marketplace-detail__byline">
                Remix 来源：
                {loadState.displayed.source.availability === 'available' ? (
                  <button type="button" onClick={() => onNavigate(
                    toneRevisionPath(loadState.displayed.source!.presetId, loadState.displayed.source!.revisionId)
                  )}>
                    {loadState.displayed.source.title}
                  </button>
                ) : '原作已不可用'}
                {' '}· @{loadState.displayed.source.creator.handle}
                {' '}· revision {loadState.displayed.source.revisionId}
              </p>
            )}
            <p className="marketplace-detail__tags">
              {loadState.displayed.tags.map((tag) => tag.nameZh).join(' · ')}
            </p>
            {!loadState.displayed.fixedRevision && loadState.displayed.visibility !== 'withdrawn' && (
              <MarketplaceLikeButton kind="preset" targetId={loadState.displayed.id} targetCreatorId={loadState.displayed.creator.id} onNavigate={onNavigate} />
            )}
            {(loadState.displayed.visibility === 'public'
              || loadState.displayed.visibility === 'unlisted') && (
              <MarketplaceReportForm
                kind="preset"
                targetId={loadState.displayed.id}
                onNavigate={onNavigate}
              />
            )}
          </div>

          {loadState.displayed.visibility === 'unlisted' && (
            <p className="marketplace-detail__warning">Unlisted：仅持有直接链接的人可访问，不进入公开发现。</p>
          )}
          {loadState.displayed.visibility === 'withdrawn' && (
            <p className="marketplace-detail__warning">作品已撤回，只有作者可以在此恢复。</p>
          )}
          {loadState.displayed.fixedRevision && (
            <p className="marketplace-detail__warning">
              这是固定修订永久链接，不会跟随当前声音变化。
              {loadState.displayed.revision.id !== loadState.displayed.currentRevisionId && (
                <button type="button" onClick={() => onNavigate(
                  tonePath(loadState.displayed.id)
                )}>查看当前修订</button>
              )}
            </p>
          )}
          <section className="marketplace-compatibility" aria-label="Tone compatibility">
            {compatibility.status === 'checking' || compatibility.status === 'idle' ? (
              <p>正在检查当前设备、器材目录与外部资源…</p>
            ) : compatibility.status === 'error' ? (
              <p className="marketplace-detail__warning">{compatibility.message} 未应用任何 Rig。</p>
            ) : <>
              <strong data-status={compatibility.value.status}>
                {compatibility.value.status === 'compatible'
                  ? '完全兼容'
                  : compatibility.value.status === 'authorization-required'
                    ? '需要 TONE3000 授权'
                    : '无法忠实应用'}
              </strong>
              {compatibility.value.blockers.length > 0 && (
                <ul>{compatibility.value.blockers.map((blocker, index) => (
                  <li key={`${blocker.kind}-${index}`}>{compatibilityBlockerMessage(blocker)}</li>
                ))}</ul>
              )}
              {compatibility.value.status === 'incompatible' && (
                <p>原始修订仍可查看且不会被改写。你可以从当前 Rig 手动替换器材后，发布为新 Revision 或 Remix。</p>
              )}
            </>}
          </section>

          <dl className="marketplace-rig-summary">
            <div><dt>Pedals</dt><dd>{loadState.displayed.derivedAttributes.pedalIds.join('、') || 'None'}</dd></div>
            <div><dt>Amp</dt><dd>{loadState.displayed.derivedAttributes.ampModelKey}</dd></div>
            <div><dt>Cab</dt><dd>{loadState.displayed.derivedAttributes.cabId}</dd></div>
            <div><dt>Resources</dt><dd>{loadState.displayed.revision.resourceDependencies.map(dependencyLabel).join('、')}</dd></div>
          </dl>

          {loadState.displayed.revision.payloadKind === 'canonical-rig' && (
            <details className="marketplace-rig-detail">
              <summary>查看完整 Rig 配置</summary>
              <h3>Pedal chain</h3>
              {loadState.displayed.revision.rig.chain.length === 0 ? <p>没有 Pedal。</p> : (
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

          {loadState.displayed.revision.resourceDependencies.some((item) => item.kind === 'tone3000') && (
            <p className="marketplace-detail__warning">此音色依赖 TONE3000；外部资源不可用时会明确提示，不会替换原始修订。</p>
          )}

          {loadState.displayed.visibility !== 'withdrawn' && (
            <div className="marketplace-detail__actions">
              {compatibility.status === 'ready' && compatibility.value.status === 'compatible' && (
                <button type="button" disabled={busy || !capability.supported} onClick={() => void applyToPedalboard(loadState.displayed)}>
                  {busy ? '处理中…' : 'Use in Pedalboard'}
                </button>
              )}
              {compatibility.status === 'ready' && compatibility.value.status === 'authorization-required' && (
                <button type="button" disabled={busy || !capability.supported} onClick={() => void connectAndContinue(loadState.displayed)}>
                  {busy ? '正在连接…' : 'Connect & Continue'}
                </button>
              )}
              {compatibility.status === 'ready' && compatibility.value.status === 'incompatible' && (
                <button type="button" disabled={busy} onClick={() => beginManualRepair(loadState.displayed)}>
                  Start Manual Repair
                </button>
              )}
              <button type="button" disabled={busy} onClick={() => setShowCollectionDialog(true)}>
                Add to Collection
              </button>
              {actionMessage && <span>{actionMessage}</span>}
            </div>
          )}

          {!capability.supported && (
            <div className="marketplace-detail__warning">
              <strong>此浏览器不支持 Pedalboard 音频运行时</strong>
              <span>缺少：{capability.missing.join('、')}。Use in Pedalboard 已禁用。</span>
              <ShareLinkFallback
                pathname={toneRevisionPath(loadState.displayed.id, loadState.displayed.revision.id)}
              />
            </div>
          )}
          {capability.supported && compactViewport && (
            <p className="marketplace-device-hint">此设备具备所需音频能力，可以继续；Pedalboard 的完整控制面在桌面或平板横屏上体验更佳。</p>
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
        </div>
      )}
    </section>
  );
}
