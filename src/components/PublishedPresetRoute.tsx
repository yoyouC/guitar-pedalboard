import { useEffect, useRef, useState } from 'react';
import type { PublishedPreset, RigResourceDependency } from '../../shared/marketplace';
import { createPublishedPresetRigSession } from '../marketplace/applyPublishedPreset';
import { marketplaceClient } from '../marketplace/client';
import { publishedPresetIdFromPath } from '../marketplace/route';
import { rigStore } from '../state/useRig';

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; preset: PublishedPreset }
  | { status: 'error'; message: string };

function dependencyLabel(dependency: RigResourceDependency): string {
  if (dependency.kind === 'builtin') return '仅内置资源';
  return `TONE3000 tone ${dependency.toneId}${dependency.modelId ? ` / model ${dependency.modelId}` : ''}`;
}

export interface PublishedPresetRouteProps {
  pathname: string;
  onClose(): void;
}

export function PublishedPresetRoute({ pathname, onClose }: PublishedPresetRouteProps) {
  const presetId = publishedPresetIdFromPath(pathname);
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
    marketplaceClient.getPublishedPreset(presetId).then(
      (preset) => {
        if (active) setLoadState({ status: 'ready', preset });
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
    return () => {
      active = false;
    };
  }, [presetId, attempt]);

  useEffect(() => {
    if (!presetId || loadState.status !== 'ready') return;
    const previousTitle = document.title;
    document.title = `${loadState.preset.title} · Guitar Pedalboard`;
    return () => {
      document.title = previousTitle;
    };
  }, [loadState, presetId]);

  if (!presetId) return null;

  const apply = async (preset: PublishedPreset) => {
    setBusy(true);
    const result = await rigSession.apply(preset);
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
            <h2>{loadState.preset.title}</h2>
            <p>{loadState.preset.description || '作者没有填写介绍。'}</p>
            <p className="marketplace-detail__byline">
              @{loadState.preset.creator.handle} · revision {loadState.preset.currentRevision.id}
            </p>
          </div>

          <dl className="marketplace-rig-summary">
            <div><dt>Pedals</dt><dd>{loadState.preset.currentRevision.rig.chain.length || 'None'}</dd></div>
            <div><dt>Amp</dt><dd>{loadState.preset.currentRevision.rig.amp.modelKey}</dd></div>
            <div><dt>Cab</dt><dd>{loadState.preset.currentRevision.rig.cab.id}</dd></div>
            <div><dt>Resources</dt><dd>{loadState.preset.currentRevision.resourceDependencies.map(dependencyLabel).join('、')}</dd></div>
          </dl>

          {loadState.preset.currentRevision.resourceDependencies.some((item) => item.kind === 'tone3000') && (
            <p className="marketplace-detail__warning">此音色依赖 TONE3000；外部资源不可用时会明确提示，不会替换原始修订。</p>
          )}

          <div className="marketplace-detail__actions">
            <button type="button" disabled={busy} onClick={() => void apply(loadState.preset)}>
              {busy ? '处理中…' : '应用到当前 Rig'}
            </button>
            {rigSession.canUndo() && (
              <button type="button" disabled={busy} onClick={() => void undo()}>撤销应用</button>
            )}
            {actionMessage && <span>{actionMessage}</span>}
          </div>
        </div>
      )}
    </section>
  );
}
