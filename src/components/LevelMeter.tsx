import { useEffect, useRef } from 'react';

interface LevelMeterProps {
  analyser: AnalyserNode | null;
  label: string;
  /** 校准目标区(dBFS),如输入表的 [-18, -12];不传则不绘制 */
  targetBandDb?: readonly [number, number];
}

const FLOOR_DB = -60;
/** 峰值达到该线性值视为削波(≈ -0.1dBFS) */
const CLIP_THRESHOLD = 0.99;
const CLIP_HOLD_MS = 1500;
const PEAK_HOLD_MS = 1200;
const PEAK_DECAY_DB_PER_SEC = 20;

/** dB 归一化到 0..1(-60dB..0dB) */
function norm(db: number): number {
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
}

/** 电平表:RMS 条 + 峰值保持刻度 + 削波红区(保持 1.5s),可选校准目标带 */
export function LevelMeter({ analyser, label, targetBandDb }: LevelMeterProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!analyser) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g2d = canvas.getContext('2d');
    if (!g2d) return;

    const data = new Float32Array(analyser.fftSize);
    let raf = 0;
    let peakHoldDb = FLOOR_DB;
    let peakHoldAt = 0;
    let clipUntil = 0;
    let lastT = performance.now();

    const draw = () => {
      const now = performance.now();
      const dt = (now - lastT) / 1000;
      lastT = now;

      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const a = Math.abs(data[i]);
        if (a > peak) peak = a;
        sum += data[i] * data[i];
      }
      const rmsDb = 20 * Math.log10(Math.sqrt(sum / data.length) + 1e-8);
      const peakDb = 20 * Math.log10(peak + 1e-8);

      // 峰值保持:先钉住,超时后按固定速率回落
      if (peakDb >= peakHoldDb) {
        peakHoldDb = peakDb;
        peakHoldAt = now;
      } else if (now - peakHoldAt > PEAK_HOLD_MS) {
        peakHoldDb = Math.max(FLOOR_DB, peakHoldDb - PEAK_DECAY_DB_PER_SEC * dt);
      }
      // getFloatTimeDomainData 不截断,可观测链内 >±1 的过载
      if (peak >= CLIP_THRESHOLD) clipUntil = now + CLIP_HOLD_MS;

      const { width, height } = canvas;
      g2d.clearRect(0, 0, width, height);
      g2d.fillStyle = '#1a1d21';
      g2d.fillRect(0, 0, width, height);

      // 校准目标带(输入表:用力弹奏让峰值进入绿区)
      if (targetBandDb) {
        const x0 = norm(targetBandDb[0]) * width;
        const x1 = norm(targetBandDb[1]) * width;
        g2d.fillStyle = 'rgba(46, 204, 113, 0.18)';
        g2d.fillRect(x0, 0, x1 - x0, height);
      }

      // RMS 条
      const grad = g2d.createLinearGradient(0, 0, width, 0);
      grad.addColorStop(0, '#2ecc71');
      grad.addColorStop(0.7, '#f1c40f');
      grad.addColorStop(1, '#e74c3c');
      g2d.fillStyle = grad;
      g2d.fillRect(0, 0, Math.round(width * norm(rmsDb)), height);

      // 峰值保持刻度
      const px = Math.round(width * norm(peakHoldDb));
      g2d.fillStyle = '#ecf0f1';
      g2d.fillRect(Math.min(px, width - 2), 0, 2, height);

      // 削波指示(右侧红块,保持 1.5s)
      if (now < clipUntil) {
        g2d.fillStyle = '#e74c3c';
        g2d.fillRect(width - 5, 0, 5, height);
      }

      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [analyser, targetBandDb]);

  return (
    <div className="level-meter">
      <span className="level-meter-label">{label}</span>
      <canvas ref={canvasRef} width={120} height={10} />
    </div>
  );
}
