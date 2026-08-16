import { useEffect, useState, useSyncExternalStore } from 'react';
import { rigStore, useRig } from '../state/useRig';
import { rigToShareState } from '../state/rigStore';
import { parseTone3000Key } from '../audio/namWasm';
import { encodeShareState } from '../state/share';
import {
  browseTone3000,
  logoutTone3000,
  replaceTone3000,
  tone3000,
  subscribeTone3000Auth,
  getTone3000Authenticated,
} from '../tone3000/instance';
import { getCachedToneInfo, putCachedToneInfo } from '../tone3000/toneInfoCache';
import type { ToneInfo } from '../tone3000/client';

/**
 * TONE3000 分类面板(ADR-0007):登录/浏览 Select 流程入口 + 当前模型卡片。
 * 归属展示(作者/许可/来源链接 + Powered by TONE3000)是 API 条款的强制项,
 * 不可裁剪或隐藏。
 */
export function Tone3000Panel() {
  const authed = useSyncExternalStore(subscribeTone3000Auth, getTone3000Authenticated);
  const modelKey = useRig((s) => s.ampModelKeys[s.ampCategoryId]);
  const notice = useRig((s) => s.tone3000Notice);
  const toneId = modelKey ? parseTone3000Key(modelKey) : null;
  const [tone, setTone] = useState<ToneInfo | null>(null);
  const [toneError, setToneError] = useState<string | null>(null);

  // 当前模型元数据(作者/许可/链接,ToS 强制展示):登出时回退到本地缓存
  // (用户自己装载过的模型归属,见 toneInfoCache.ts);恢复路径的友好降级在 #14
  useEffect(() => {
    setTone(toneId ? getCachedToneInfo(toneId, window.localStorage) : null);
    setToneError(null);
    if (!authed || !toneId) return;
    let cancelled = false;
    tone3000
      .getTone(toneId)
      .then((info) => {
        putCachedToneInfo(info, window.localStorage);
        if (!cancelled) setTone(info);
      })
      .catch((e: unknown) => {
        if (!cancelled) setToneError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [authed, toneId]);

  const startBrowse = () =>
    void browseTone3000(() => encodeShareState(rigToShareState(rigStore.getState())));

  return (
    <div className="tone3000-panel">
      {authed ? (
        <>
          <button className="nam-load-btn" onClick={startBrowse}>
            浏览 TONE3000 选模型…
          </button>
          <button className="tone3000-logout" title="登出 TONE3000" onClick={logoutTone3000}>
            登出
          </button>
        </>
      ) : (
        <button className="nam-load-btn" onClick={startBrowse}>
          登录 TONE3000 选模型…
        </button>
      )}

      {toneId && (
        <div className="tone3000-current">
          {tone ? (
            <>
              <span className="tone3000-title">{tone.title}</span>
              <span className="tone3000-byline">
                by {tone.username} · {tone.license.toUpperCase()}
              </span>
              <a href={tone.url} target="_blank" rel="noreferrer">
                在 TONE3000 查看
              </a>
            </>
          ) : (
            <span className="tone3000-byline">
              {toneError ?? (authed ? '模型信息加载中…' : '登录后可查看模型信息')}
            </span>
          )}
        </div>
      )}

      {notice && (
        <div className="tone3000-notice" role="alert">
          <span className="tone3000-notice-text">
            {notice.reason === 'not-authenticated' && (
              <>该模型需要登录 TONE3000,箱头已回退为默认。</>
            )}
            {notice.reason === 'tone-unavailable' && (
              <>原模型已失效(可能已被作者删除或转私有),箱头已回退为默认。</>
            )}
            {notice.reason === 'http' && <>模型下载失败(网络问题),箱头已回退为默认。</>}
          </span>
          {notice.reason === 'not-authenticated' && (
            <button className="nam-load-btn" onClick={startBrowse}>
              登录 TONE3000
            </button>
          )}
          {notice.reason === 'tone-unavailable' && (
            <button
              className="nam-load-btn"
              onClick={() =>
                void replaceTone3000(notice.toneId, () =>
                  encodeShareState(rigToShareState(rigStore.getState())),
                )
              }
            >
              在 TONE3000 选择替代模型…
            </button>
          )}
          {notice.reason === 'http' && modelKey && (
            <button className="nam-load-btn" onClick={() => rigStore.setAmpModel('tone3000', modelKey)}>
              重试
            </button>
          )}
        </div>
      )}

      <div className="tone3000-powered">
        Powered by{' '}
        <a href="https://www.tone3000.com" target="_blank" rel="noreferrer">
          TONE3000
        </a>
      </div>
    </div>
  );
}
