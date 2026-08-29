import { useEffect, useState, useSyncExternalStore } from 'react';
import type { PresetCollection, PublishedPresetRevisionCompatibility } from '../../shared/marketplace';
import { collectionQueue } from '../marketplace/collectionQueueSession';
import { marketplaceClient } from '../marketplace/client';
import { presetCollectionIdFromPath, toneRevisionPath } from '../marketplace/route';
import { useMarketplacePageMetadata } from '../marketplace/pageMetadata';
import { useToneSession } from '../marketplace/toneSession';
import { rigStore } from '../state/useRig';
import { MarketplaceLikeButton } from './MarketplaceLikeButton';
import { MarketplaceReportForm } from './MarketplaceReportForm';
import {
  compatibilityBlockerMessage,
  resolvePublishedRevisionCompatibility,
} from '../marketplace/revisionCompatibility';
import { browserTone3000Compatibility } from '../marketplace/revisionCompatibilityBrowser';
import { browserPedalboardCapability } from '../marketplace/pedalboardCapability';
import { ShareLinkFallback } from './ShareLinkFallback';

interface PresetCollectionRouteProps {
  pathname: string;
  onClose(): void;
  onNavigate(pathname: string): void;
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; collection: PresetCollection }
  | { status: 'error'; message: string };

type ItemCompatibilityState =
  | { status: 'checking' }
  | { status: 'error'; message: string }
  | { status: 'ready'; value: PublishedPresetRevisionCompatibility };

export function PresetCollectionRoute({ pathname, onClose, onNavigate }: PresetCollectionRouteProps) {
  const collectionId = presetCollectionIdFromPath(pathname);
  const queue = useSyncExternalStore(collectionQueue.subscribe, collectionQueue.getState);
  const tone = useToneSession();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const [startPosition, setStartPosition] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [itemCompatibility, setItemCompatibility] = useState<Record<number, ItemCompatibilityState>>({});
  const capability = browserPedalboardCapability();

  useEffect(() => {
    if (!collectionId) return;
    let active = true;
    setState({ status: 'loading' });
    void marketplaceClient.getPresetCollection(collectionId).then((collection) => {
      if (!active) return;
      setState({ status: 'ready', collection });
      setStartPosition(null);
      setItemCompatibility(Object.fromEntries(collection.items.map((item) => [
        item.position,
        item.availability === 'available'
          ? { status: 'checking' as const }
          : { status: 'error' as const, message: '原作当前不可用' },
      ])));
      void Promise.all(collection.items.map(async (item) => {
        if (item.availability !== 'available') return [item.position, {
          status: 'error' as const, message: '原作当前不可用',
        }] as const;
        try {
          const revision = await marketplaceClient.getPublishedPresetRevision(
            item.presetId,
            item.revisionId,
          );
          return [item.position, {
            status: 'ready' as const,
            value: await resolvePublishedRevisionCompatibility(
              revision.revision,
              browserTone3000Compatibility,
            ),
          }] as const;
        } catch (cause) {
          return [item.position, {
            status: 'error' as const,
            message: cause instanceof Error ? cause.message : '兼容性检查失败',
          }] as const;
        }
      })).then((entries) => {
        if (!active) return;
        const compatibility = Object.fromEntries(entries);
        setItemCompatibility(compatibility);
        setStartPosition(collection.items.find((item) => (
          compatibility[item.position]?.status === 'ready'
          && compatibility[item.position].value.status === 'compatible'
        ))?.position ?? null);
      });
    }, (cause: unknown) => {
      if (active) setState({
        status: 'error',
        message: cause instanceof Error ? cause.message : '预设合集暂时不可用。',
      });
    });
    return () => { active = false; };
  }, [collectionId, attempt]);

  useMarketplacePageMetadata(state.status === 'ready' ? {
    kind: 'collection',
    id: state.collection.id,
    title: state.collection.title,
    description: state.collection.description,
    visibility: state.collection.visibility === 'hidden' ? 'withdrawn' : state.collection.visibility,
  } : null);

  const launchCollection = async (collection: PresetCollection) => {
    if (startPosition === null) return;
    setBusy(true);
    setMessage('');
    const blockedReasons = Object.fromEntries(collection.items.flatMap((item) => {
      const state = itemCompatibility[item.position];
      if (state?.status === 'ready' && state.value.status === 'compatible') return [];
      const reason = state?.status === 'ready'
        ? state.value.blockers.map(compatibilityBlockerMessage).join('；')
        : state?.status === 'error'
          ? state.message
          : '兼容性尚未确认';
      return [[item.position, reason]];
    }));
    const result = await collectionQueue.start(collection, startPosition, blockedReasons);
    setBusy(false);
    if (result.ok) onNavigate('/');
    else setMessage(result.message ?? '无法启动 Collection 队列。');
  };
  const requestLaunch = (collection: PresetCollection) => {
    if (tone.modified) {
      setPresetName(`${tone.tone?.title ?? 'Tone'} edit`);
      setConfirmReplace(true);
      return;
    }
    void launchCollection(collection);
  };

  if (!collectionId) return null;
  const activeQueue = queue.queue;
  return (
    <section className="marketplace-detail" aria-live="polite">
      <div className="marketplace-detail__topline"><span className="marketplace-detail__eyebrow">Tone Market · Preset Collection</span><button className="marketplace-detail__close" type="button" onClick={onClose}>返回效果器</button></div>
      {state.status === 'idle' || state.status === 'loading' ? <p>正在读取合集…</p> : state.status === 'error' ? <div className="marketplace-detail__error" role="alert"><strong>未能打开这个合集</strong><p>{state.message}</p><button type="button" onClick={() => setAttempt((current) => current + 1)}>重试</button></div> : <div className="marketplace-detail__content">
        <h2>{state.collection.title}</h2><p>{state.collection.description || '作者没有填写介绍。'}</p><p className="marketplace-detail__byline">@{state.collection.creator.handle}</p><p className="marketplace-detail__tags">{state.collection.tags.map((tag) => tag.nameZh).join(' · ')}</p>
        {state.collection.visibility !== 'withdrawn' && <MarketplaceLikeButton kind="collection" targetId={state.collection.id} targetCreatorId={state.collection.creator.id} onNavigate={onNavigate} />}
        {(state.collection.visibility === 'public' || state.collection.visibility === 'unlisted') && <MarketplaceReportForm kind="collection" targetId={state.collection.id} onNavigate={onNavigate} />}
        {state.collection.visibility !== 'public' && <p className="marketplace-detail__warning">{state.collection.visibility === 'unlisted' ? 'Unlisted：仅持有直接链接的人可访问。' : '合集已撤回，只有作者可管理。'}</p>}
        <section className="collection-use-panel" aria-label="Collection queue preview">
          <div><h3>Choose a starting Tone</h3><p>队列只保存在当前浏览器会话；不可用位置会保留并在前后切换时跳过。</p></div>
          <ol className="collection-detail__items">{state.collection.items.map((item) => {
            const current = activeQueue?.collectionId === state.collection.id
              && activeQueue.currentPosition === item.position;
            const compatibility = itemCompatibility[item.position];
            const usable = compatibility?.status === 'ready'
              && compatibility.value.status === 'compatible';
            const compatibilityText = compatibility?.status === 'checking'
              ? '正在检查兼容性…'
              : compatibility?.status === 'error'
                ? compatibility.message ?? '不可用'
                : compatibility
                  ? compatibility.value.status === 'compatible'
                    ? '完全兼容'
                    : compatibility.value.blockers.map(compatibilityBlockerMessage).join('；')
                  : '等待检查';
            return <li key={`${item.position}-${item.presetId}-${item.revisionId}`} className={!usable ? 'unavailable' : ''}>
              <span className="collection-detail__position">{item.position + 1}</span>
              <input type="radio" name="collection-start" aria-label={`从位置 ${item.position + 1} 开始`} disabled={!usable} checked={startPosition === item.position} onChange={() => setStartPosition(item.position)} />
              <div>{item.availability === 'available' ? <button type="button" onClick={() => onNavigate(toneRevisionPath(item.presetId, item.revisionId))}>{item.title}</button> : <strong>原作当前不可用</strong>}<small>@{item.creator.handle} · fixed revision {item.revisionId}{current ? ' · Now playing' : ''}</small><small>{compatibilityText}</small></div>
            </li>;
          })}</ol>
          {state.collection.items.length === 0 && <p>这个合集还没有条目。</p>}
          <button type="button" disabled={busy || startPosition === null || !capability.supported} onClick={() => requestLaunch(state.collection)}>{busy ? '正在载入固定修订…' : 'Use Collection in Pedalboard'}</button>
          {!capability.supported && <div className="marketplace-detail__warning"><strong>此浏览器缺少 Pedalboard 音频能力</strong><span>缺少：{capability.missing.join('、')}</span><ShareLinkFallback pathname={pathname} label="Collection" /></div>}
          {confirmReplace && <div className="tone-session-bar__decision" role="dialog" aria-modal="true" aria-label="当前 Tone 已修改">
            <strong>当前 Tone 已修改</strong><p>启动新队列会丢弃这些改动。</p>
            <label>Local Preset 名称<input value={presetName} onChange={(event) => setPresetName(event.target.value)} /></label>
            <div><button type="button" disabled={!presetName.trim() || busy} onClick={() => { rigStore.savePreset(presetName.trim()); setConfirmReplace(false); void launchCollection(state.collection); }}>Save as Local Preset</button><button type="button" disabled={busy} onClick={() => { setConfirmReplace(false); void launchCollection(state.collection); }}>Discard &amp; Continue</button><button type="button" disabled={busy} onClick={() => setConfirmReplace(false)}>Cancel</button></div>
          </div>}
          {message && <p role="alert">{message}</p>}
        </section>
      </div>}
    </section>
  );
}
