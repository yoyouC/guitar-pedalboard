import { useEffect, useState } from 'react';
import { tone3000 } from '../tone3000/instance';
import { parseToneUrl, type ToneInfo } from '../tone3000/client';

/**
 * TONE3000 发现区(issue #15):粘贴链接装载 + trending/latest 列表。
 * 仅登录态渲染(免费层条款的有界端点需 Bearer);列表不落盘
 * (条款禁止缓存目录,归属元数据缓存是 toneInfoCache 的事)。
 */
interface Tone3000DiscoverProps {
  /** 当前装载的 toneId(列表高亮用) */
  currentToneId: string | null;
  /** 统一装载入口(记入型号记忆;info 用于归属元数据缓存) */
  onLoad(id: string, info?: ToneInfo): void;
  gear?: 'amp' | 'pedal';
  showLatest?: boolean;
}

export function Tone3000Discover({
  currentToneId,
  onLoad,
  gear,
  showLatest = true,
}: Tone3000DiscoverProps) {
  const [feed, setFeed] = useState<'trending' | 'latest'>('trending');
  const [feedTones, setFeedTones] = useState<ToneInfo[] | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [pasteValue, setPasteValue] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);

  // 列表(切换 tab 重新拉取;按需获取,不持久化)
  useEffect(() => {
    let cancelled = false;
    setFeedTones(null);
    setFeedError(null);
    tone3000
      .listTones(feed, gear)
      .then((tones) => {
        if (!cancelled) setFeedTones(tones);
      })
      .catch((e: unknown) => {
        if (!cancelled) setFeedError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [feed, gear]);

  // 粘贴链接装载:非法输入明确报错,当前状态不变
  const submitPaste = () => {
    const id = parseToneUrl(pasteValue);
    if (!id) {
      setPasteError('无法识别的 TONE3000 链接(应为 https://www.tone3000.com/tones/…-数字 id)');
      return;
    }
    setPasteError(null);
    setPasteValue('');
    onLoad(id);
  };

  return (
    <div className="tone3000-discover">
      <div className="tone3000-paste-row">
        <input
          className="tone3000-paste-input"
          type="text"
          placeholder="粘贴 TONE3000 模型链接,回车装载…"
          value={pasteValue}
          onChange={(e) => {
            setPasteValue(e.target.value);
            setPasteError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitPaste();
          }}
        />
        <button className="nam-load-btn" onClick={submitPaste}>
          装载
        </button>
      </div>
      {pasteError && <div className="tone3000-paste-error">{pasteError}</div>}

      {showLatest && <div className="tone3000-feed-tabs">
        <button
          className={`tone3000-feed-tab ${feed === 'trending' ? 'active' : ''}`}
          onClick={() => setFeed('trending')}
        >
          热门
        </button>
        <button
          className={`tone3000-feed-tab ${feed === 'latest' ? 'active' : ''}`}
          onClick={() => setFeed('latest')}
        >
          最新
        </button>
      </div>}
      {feedError && <div className="tone3000-paste-error">{feedError}</div>}
      {!feedError && feedTones === null && <div className="tone3000-byline">列表加载中…</div>}
      {feedTones && (
        <ul className="tone3000-feed">
          {feedTones.map((t) => (
            <li key={t.id}>
              <button
                className={`tone3000-feed-item ${currentToneId === String(t.id) ? 'active' : ''}`}
                onClick={() => onLoad(String(t.id), t)}
              >
                {t.imageUrl && <img className="tone3000-thumb" src={t.imageUrl} alt="" />}
                <span className="tone3000-title">{t.title}</span>
                <span className="tone3000-byline">
                  {t.gear ? `${t.gear} · ` : ''}{t.format ? `${t.format.toUpperCase()} · ` : ''}
                  by {t.username} · {t.license.toUpperCase()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
