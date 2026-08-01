import { useEffect, useRef, useState } from 'react';

/** 从常见 YouTube URL 形式中解析 11 位 videoId */
function parseVideoId(url: string): string | null {
  const m = url
    .trim()
    .match(/(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ytApiPromise: Promise<any> | null = null;

/** 全局只加载一次 YouTube IFrame API */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadYTApi(): Promise<any> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!ytApiPromise) {
    ytApiPromise = new Promise((resolve) => {
      window.onYouTubeIframeAPIReady = () => resolve(window.YT);
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    });
  }
  return ytApiPromise;
}

interface YouTubeBackgroundProps {
  /** 视频背景激活/退出时通知(App 用来隐藏流体背景) */
  onActiveChange?: (active: boolean) => void;
}

/**
 * POC:YouTube 视频全屏背景。
 * iframe pointer-events 关闭,通过 IFrame API 控制播放/静音;
 * 默认静音自动播放(浏览器自动播放策略),可手动开声当伴奏。
 */
export function YouTubeBackground({ onActiveChange }: YouTubeBackgroundProps) {
  const [urlInput, setUrlInput] = useState('');
  const [videoId, setVideoId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [dim, setDim] = useState(0.55);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const playerRef = useRef<any>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  // 创建/销毁播放器
  useEffect(() => {
    if (!videoId || !hostRef.current) return;
    let cancelled = false;
    loadYTApi().then((YT) => {
      if (cancelled || !hostRef.current) return;
      playerRef.current = new YT.Player(hostRef.current, {
        videoId,
        playerVars: {
          autoplay: 1,
          controls: 0,
          rel: 0,
          playsinline: 1,
          iv_load_policy: 3,
          disablekb: 1,
          modestbranding: 1,
          loop: 1,
          playlist: videoId, // loop 单视频时必须带 playlist
        },
        events: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onReady: (e: any) => {
            // 静音后才允许自动播放
            e.target.mute();
            e.target.playVideo();
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onStateChange: (e: any) => {
            setPlaying(e.data === YT.PlayerState.PLAYING);
          },
        },
      });
    });
    return () => {
      cancelled = true;
      playerRef.current?.destroy?.();
      playerRef.current = null;
    };
  }, [videoId]);

  // 通知 App 隐藏/恢复流体背景
  useEffect(() => {
    onActiveChange?.(videoId !== null);
  }, [videoId, onActiveChange]);

  const load = () => {
    const id = parseVideoId(urlInput);
    if (!id) {
      setError('无法识别的 YouTube 链接');
      return;
    }
    setError('');
    setMuted(true);
    setPlaying(false);
    setVideoId(id);
  };

  const close = () => {
    setVideoId(null);
    setPlaying(false);
    setMuted(true);
    setError('');
  };

  const togglePlay = () => {
    const p = playerRef.current;
    if (!p) return;
    if (playing) p.pauseVideo();
    else p.playVideo();
  };

  const toggleMute = () => {
    const p = playerRef.current;
    if (!p) return;
    if (muted) {
      p.unMute();
      p.playVideo();
      setMuted(false);
    } else {
      p.mute();
      setMuted(true);
    }
  };

  return (
    <>
      {videoId && (
        <div className="yt-bg">
          <div className="yt-bg-cover">
            <div ref={hostRef} className="yt-bg-host" />
          </div>
          <div className="yt-bg-dim" style={{ opacity: dim }} />
        </div>
      )}

      <div className="yt-panel">
        {videoId ? (
          <>
            <button onClick={togglePlay} title={playing ? '暂停' : '播放'}>
              {playing ? '⏸' : '▶'}
            </button>
            <button onClick={toggleMute} title={muted ? '取消静音(视频原声)' : '静音'}>
              {muted ? '🔇' : '🔊'}
            </button>
            <label className="yt-dim">
              暗化
              <input
                type="range"
                min={0}
                max={0.85}
                step={0.05}
                value={dim}
                onChange={(e) => setDim(Number(e.target.value))}
              />
            </label>
            <button onClick={close} title="关闭视频背景">
              ✕
            </button>
          </>
        ) : (
          <>
            <input
              type="text"
              placeholder="粘贴 YouTube 链接,视频当背景…"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load()}
            />
            <button onClick={load}>加载</button>
            {error && <span className="yt-error">{error}</span>}
          </>
        )}
      </div>
    </>
  );
}
