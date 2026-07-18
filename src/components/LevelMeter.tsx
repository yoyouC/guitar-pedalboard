import { useEffect, useRef } from 'react';

interface LevelMeterProps {
  analyser: AnalyserNode | null;
  label: string;
}

/** 基于 AnalyserNode 的 RMS 电平表(canvas + rAF) */
export function LevelMeter({ analyser, label }: LevelMeterProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!analyser) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g2d = canvas.getContext('2d');
    if (!g2d) return;

    const data = new Float32Array(analyser.fftSize);
    let raf = 0;

    const draw = () => {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      const db = 20 * Math.log10(rms + 1e-8);
      // -60dB..0dB 归一化到 0..1
      const level = Math.min(1, Math.max(0, (db + 60) / 60));

      const { width, height } = canvas;
      g2d.clearRect(0, 0, width, height);
      g2d.fillStyle = '#1a1d21';
      g2d.fillRect(0, 0, width, height);

      const barWidth = Math.round(width * level);
      const grad = g2d.createLinearGradient(0, 0, width, 0);
      grad.addColorStop(0, '#2ecc71');
      grad.addColorStop(0.7, '#f1c40f');
      grad.addColorStop(1, '#e74c3c');
      g2d.fillStyle = grad;
      g2d.fillRect(0, 0, barWidth, height);

      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [analyser]);

  return (
    <div className="level-meter">
      <span className="level-meter-label">{label}</span>
      <canvas ref={canvasRef} width={120} height={10} />
    </div>
  );
}
