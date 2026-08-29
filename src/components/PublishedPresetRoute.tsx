import { useEffect, useRef, useState } from 'react';
import type {
  PublishedPreset,
  PublishedPresetRevision,
  PublishedPresetRevisionView,
  RigDerivedAttributes,
  RigResourceDependency,
} from '../../shared/marketplace';
import { isPublishedPresetRevisionCompatible } from '../../shared/marketplaceValidation';
import { createPublishedPresetRigSession } from '../marketplace/applyPublishedPreset';
import { marketplaceClient } from '../marketplace/client';
import { publishedPresetRouteFromPath } from '../marketplace/route';
import { rigStore } from '../state/useRig';
import { PublishedPresetManager } from './PublishedPresetManager';

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
  | { status: 'error'; message: string };

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
  const rigSessionRef = useRef<ReturnType<typeof createPublishedPresetRigSession> | null>(null);
  const rigSession = rigSessionRef.current ?? createPublishedPresetRigSession(rigStore);
  rigSessionRef.current = rigSession;

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
            message: error instanceof Error ? error.message : '音色广场暂时不可用。',
          });
        }
      },
    );
    return () => { active = false; };
  }, [presetId, revisionId, attempt]);

  useEffect(() => {
    if (!presetId || loadState.status !== 'ready') return;
    const previousTitle = document.title;
    document.title = `${loadState.displayed.title} · Guitar Pedalboard`;
    let robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const previousRobots = robots?.content ?? null;
    if (loadState.displayed.visibility !== 'public') {
      if (!robots) {
        robots = document.createElement('meta');
        robots.name = 'robots';
        document.head.append(robots);
      }
      robots.content = 'noindex,nofollow';
    }
    return () => {
      document.title = previousTitle;
      if (previousRobots === null) robots?.remove();
      else if (robots) robots.content = previousRobots;
    };
  }, [loadState, presetId]);

  if (!route) return null;

  const apply = async (displayed: DisplayedPreset) => {
    setBusy(true);
    const result = await rigSession.apply({
      id: displayed.id,
      title: displayed.title,
      creator: displayed.creator,
      updatedAt: displayed.updatedAt,
      currentRevision: displayed.revision,
    });
    setBusy(false);
    setActionMessage(result.ok ? '已应用到当前 Rig。你可以在本次会话中撤销。' : (result.message ?? '应用失败。'));
  };

  const undo = async () => {
    setBusy(true);
    const result = await rigSession.undo();
    setBusy(false);
    setActionMessage(result.ok ? '已恢复应用前的 Rig。' : (result.message ?? '撤销失败。'));
  };

  return (
    <section className="marketplace-detail" aria-live="polite">
      <div className="marketplace-detail__topline">
        <span className="marketplace-detail__eyebrow">音色广场 · Published Preset</span>
        <button className="marketplace-detail__close" type="button" onClick={onClose}>返回效果器</button>
      </div>

      {loadState.status === 'loading' || loadState.status === 'idle' ? (
        <p>正在读取音色…</p>
      ) : loadState.status === 'error' ? (
        <div className="marketplace-detail__error" role="alert">
          <strong>未能打开这个音色</strong>
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
                    `/marketplace/presets/${encodeURIComponent(loadState.displayed.source!.presetId)}`
                    + `/revisions/${encodeURIComponent(loadState.displayed.source!.revisionId)}`
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
                  `/marketplace/presets/${encodeURIComponent(loadState.displayed.id)}`
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

          {loadState.displayed.revision.resourceDependencies.some((item) => item.kind === 'tone3000') && (
            <p className="marketplace-detail__warning">此音色依赖 TONE3000；外部资源不可用时会明确提示，不会替换原始修订。</p>
          )}

          {loadState.displayed.visibility !== 'withdrawn' && loadState.displayed.compatible && (
            <div className="marketplace-detail__actions">
              <button type="button" disabled={busy} onClick={() => void apply(loadState.displayed)}>
                {busy ? '处理中…' : '应用到当前 Rig'}
              </button>
              {rigSession.canUndo() && (
                <button type="button" disabled={busy} onClick={() => void undo()}>撤销应用</button>
              )}
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
        </div>
      )}
    </section>
  );
}
