import { useEffect, useState } from 'react';
import type {
  PublishedPreset,
  PublishedPresetRevision,
  PublishedPresetRevisionView,
  RigDerivedAttributes,
  RigResourceDependency,
} from '../../shared/marketplace';
import { isPublishedPresetRevisionCompatible } from '../../shared/marketplaceValidation';
import { MarketplaceClientError, marketplaceClient } from '../marketplace/client';
import { useMarketplacePageMetadata } from '../marketplace/pageMetadata';
import { publishedPresetRouteFromPath, tonePath, toneRevisionPath } from '../marketplace/route';
import { toneSession } from '../marketplace/toneSession';
import { collectionQueue } from '../marketplace/collectionQueueSession';
import { AddToCollectionDialog } from './AddToCollectionDialog';
import { PublishedPresetManager } from './PublishedPresetManager';
import { MarketplaceLikeButton } from './MarketplaceLikeButton';
import { MarketplaceReportForm } from './MarketplaceReportForm';

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
  compatible: boolean;
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; displayed: DisplayedPreset; managedPreset: PublishedPreset | null }
  | { status: 'error'; kind: 'not-found' | 'unavailable'; message: string };

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
    compatible: isPublishedPresetRevisionCompatible(preset.currentRevision),
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
    compatible: isPublishedPresetRevisionCompatible(preset.revision),
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

  useMarketplacePageMetadata(loadState.status === 'ready' ? {
    kind: 'preset',
    id: loadState.displayed.id,
    revisionId: loadState.displayed.fixedRevision ? loadState.displayed.revision.id : null,
    title: loadState.displayed.title,
    description: loadState.displayed.description,
    visibility: loadState.displayed.visibility,
  } : null);

  if (!route) return null;

  const apply = async (displayed: DisplayedPreset) => {
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
    }
    else setActionMessage(result.message ?? '应用失败。');
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
          {!loadState.displayed.compatible && (
            <p className="marketplace-detail__warning">
              当前客户端无法忠实应用这个历史声音；原始修订仍被保留，请升级后再试。
            </p>
          )}

          <dl className="marketplace-rig-summary">
            <div><dt>Pedals</dt><dd>{loadState.displayed.derivedAttributes.pedalIds.join('、') || 'None'}</dd></div>
            <div><dt>Amp</dt><dd>{loadState.displayed.derivedAttributes.ampModelKey}</dd></div>
            <div><dt>Cab</dt><dd>{loadState.displayed.derivedAttributes.cabId}</dd></div>
            <div><dt>Resources</dt><dd>{loadState.displayed.revision.resourceDependencies.map(dependencyLabel).join('、')}</dd></div>
          </dl>

          {loadState.displayed.compatible && loadState.displayed.revision.payloadKind === 'canonical-rig' && (
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
              {loadState.displayed.compatible && (
                <button type="button" disabled={busy} onClick={() => void apply(loadState.displayed)}>
                  {busy ? '处理中…' : 'Use in Pedalboard'}
                </button>
              )}
              <button type="button" disabled={busy} onClick={() => setShowCollectionDialog(true)}>
                Add to Collection
              </button>
              {actionMessage && <span>{actionMessage}</span>}
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
