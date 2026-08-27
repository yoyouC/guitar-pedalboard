import { useEffect, useState, useSyncExternalStore } from 'react';
import { useRig } from '../state/useRig';
import { parseTone3000Key } from '../audio/namWasm';
import {
  getTone3000Authenticated,
  subscribeTone3000Auth,
} from '../tone3000/instance';
import { getCachedToneInfo, putCachedToneInfo } from '../tone3000/toneInfoCache';
import { tone3000Rig, useTone3000Rig } from '../tone3000/useTone3000Rig';
import type { ToneInfo } from '../tone3000/client';
import { Tone3000Selector } from './Tone3000Selector';
import { Tone3000Account, Tone3000ModelAttribution } from './Tone3000Display';

/** TONE3000 箱头入口；与 NAM 单块共用选择器、精确变体与运行状态。 */
export function Tone3000Panel() {
  const authenticated = useSyncExternalStore(
    subscribeTone3000Auth,
    getTone3000Authenticated,
  );
  const modelKey = useRig((state) => state.ampModelKeys[state.ampCategoryId]);
  const modelId = useRig((state) => state.ampTone3000ModelId);
  const toneId = modelKey ? parseTone3000Key(modelKey) : null;
  const runtime = useTone3000Rig((state) => state.targets.amp);
  const [selectorMode, setSelectorMode] = useState<'select' | 'repair' | 'sample' | null>(null);
  const [cachedInfo, setCachedInfo] = useState<ToneInfo | null>(null);
  const [sampleBusy, setSampleBusy] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);

  useEffect(() => {
    setCachedInfo(toneId ? getCachedToneInfo(toneId, window.localStorage) : null);
  }, [toneId]);

  useEffect(() => {
    if (!runtime?.info) return;
    putCachedToneInfo(runtime.info, window.localStorage);
    setCachedInfo(runtime.info);
  }, [runtime?.info]);

  const loginAndRetry = async () => {
    await tone3000Rig.login();
  };

  const openSampleSwitch = async () => {
    setSampleBusy(true);
    setSampleError(null);
    try {
      const result = await tone3000Rig.prepareAmpSampleSwitch();
      if (!result.ok) throw new Error(result.message);
      if (result.status === 'choose') setSelectorMode('sample');
    } catch (cause) {
      setSampleError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSampleBusy(false);
    }
  };

  return (
    <div className="tone3000-panel">
      <button className="nam-load-btn" onClick={() => setSelectorMode('select')}>
        {toneId ? '更换 Tone…' : '浏览 TONE3000 箱头…'}
      </button>
      {toneId && (
        <button
          className="tone3000-logout"
          disabled={sampleBusy}
          onClick={() => void openSampleSwitch()}
        >
          {sampleBusy ? '正在加载采样…' : '切换采样…'}
        </button>
      )}
      {!authenticated && (
        <button className="tone3000-logout" onClick={() => void loginAndRetry()}>
          登录
        </button>
      )}
      <Tone3000Account
        actions={
          authenticated ? (
            <button className="tone3000-logout" onClick={() => tone3000Rig.logout()}>
              登出
            </button>
          ) : null
        }
      />

      {toneId && (
        <div className="tone3000-current">
          <Tone3000ModelAttribution
            info={runtime?.info ?? cachedInfo}
            fallback={`TONE3000 tone #${toneId}`}
          />
          <span className={`tone3000-runtime tone3000-runtime-${runtime?.phase ?? 'loading'}`}>
            {runtime?.phase === 'ready'
              ? '已就绪'
              : runtime?.phase === 'error'
                ? runtime.message ?? '模型不可用'
                : '加载中…'}
          </span>
          {modelId && (
            <span className="tone3000-sample-summary" title={`model #${modelId}`}>
              {runtime?.sample?.name || `采样 #${modelId}`}
              {runtime?.sample
                ? ` · ${runtime.sample.architecture === 'custom' ? 'Custom' : `A${runtime.sample.architecture}`} · ${runtime.sample.size}`
                : ''}
            </span>
          )}
        </div>
      )}

      {sampleError && <div className="tone3000-notice" role="alert">{sampleError}</div>}

      {runtime?.phase === 'error' && (
        <div className="tone3000-notice" role="alert">
          <span>{runtime.message}</span>
          {runtime.reason === 'not-authenticated' ? (
            <button className="nam-load-btn" onClick={() => void loginAndRetry()}>
              登录并重试
            </button>
          ) : runtime.reason === 'tone-unavailable' ? (
            <button className="nam-load-btn" onClick={() => setSelectorMode('repair')}>
              选择替代模型…
            </button>
          ) : (
            <button className="nam-load-btn" onClick={() => void tone3000Rig.retryAll()}>
              重试
            </button>
          )}
        </div>
      )}

      {selectorMode && (
        <Tone3000Selector
          intent={{ kind: 'amp' }}
          currentToneId={toneId}
          loadToneId={selectorMode === 'repair' ? toneId ?? undefined : undefined}
          onClose={() => setSelectorMode(null)}
        />
      )}
    </div>
  );
}
