import { useEffect, useRef, useState } from 'react';
import { audioEngine } from '../audio/AudioEngine';
import { Metronome } from '../audio/metronome';

const SIGNATURES = [2, 3, 4, 6];

/** 节拍器:播放/停止、BPM、Tap Tempo、拍号、闪灯 */
export function MetronomePanel({ engineReady }: { engineReady: boolean }) {
  const metroRef = useRef<Metronome | null>(null);
  const [playing, setPlaying] = useState(false);
  const [bpm, setBpm] = useState(100);
  const [beatsPerBar, setBeatsPerBar] = useState(4);
  const [activeBeat, setActiveBeat] = useState(-1);
  const tapsRef = useRef<number[]>([]);

  // 引擎就绪后创建实例
  useEffect(() => {
    if (!engineReady || !audioEngine.ctx || !audioEngine.metronomeBus) return;
    if (!metroRef.current) {
      metroRef.current = new Metronome(audioEngine.ctx, audioEngine.metronomeBus, (beat) => {
        setActiveBeat(beat);
      });
    }
    return () => {
      metroRef.current?.stop();
      metroRef.current = null;
    };
  }, [engineReady]);

  // 参数热更新
  useEffect(() => {
    if (metroRef.current) {
      metroRef.current.bpm = bpm;
      metroRef.current.beatsPerBar = beatsPerBar;
    }
  }, [bpm, beatsPerBar]);

  const toggle = () => {
    const m = metroRef.current;
    if (!m) return;
    if (playing) {
      m.stop();
      setPlaying(false);
      setActiveBeat(-1);
    } else {
      m.bpm = bpm;
      m.beatsPerBar = beatsPerBar;
      m.start();
      setPlaying(true);
    }
  };

  const tapTempo = () => {
    const now = performance.now();
    const taps = tapsRef.current;
    taps.push(now);
    if (taps.length > 4) taps.shift();
    if (taps.length >= 2) {
      const intervals = taps.slice(1).map((t, i) => t - taps[i]);
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      if (avg > 200 && avg < 2000) setBpm(Math.round(60000 / avg));
    }
    // 3s 无新 tap 则重新开始
    window.setTimeout(() => {
      if (tapsRef.current.length && now - tapsRef.current[tapsRef.current.length - 1] > 2000) {
        tapsRef.current = [];
      }
    }, 2100);
  };

  return (
    <div className="console-group">
      <span className="group-label">节拍器</span>
      <div className="group-body metronome-body">
        <button
          className={`metro-play ${playing ? 'playing' : ''}`}
          disabled={!engineReady}
          title={playing ? '停止' : '播放'}
          onClick={toggle}
        >
          {playing ? '■' : '▶'}
        </button>
        <div className="metro-beats">
          {Array.from({ length: beatsPerBar }, (_, i) => (
            <span
              key={i}
              className={`metro-dot ${playing && i === activeBeat ? (i === 0 ? 'dot-accent' : 'dot-on') : ''}`}
            />
          ))}
        </div>
        <div className="metro-bpm">
          <button onClick={() => setBpm((b) => Math.max(30, b - 1))}>−</button>
          <span className="metro-bpm-value">{bpm}</span>
          <button onClick={() => setBpm((b) => Math.min(300, b + 1))}>+</button>
        </div>
        <button className="metro-tap" onClick={tapTempo} title="连点两下以上测速">
          TAP
        </button>
        <select value={beatsPerBar} onChange={(e) => setBeatsPerBar(Number(e.target.value))}>
          {SIGNATURES.map((n) => (
            <option key={n} value={n}>
              {n}/4
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
