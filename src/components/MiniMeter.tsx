import { useEffect, useRef } from 'react';

/** 模块输出迷你电平表:绿 → 橙(>0.7)→ 红(>0.9,过热) */
export function MiniMeter({ analyser }: { analyser: AnalyserNode | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!analyser) return;
    const canvas = canvasRef.current;
    const g2d = canvas?.getContext('2d');
    if (!canvas || !g2d) return;

    const data = new Float32Array(analyser.fftSize);
    let raf = 0;
    const draw = () => {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const level = Math.min(1, Math.sqrt(sum / data.length) * 1.8);

      g2d.fillStyle = '#101215';
      g2d.fillRect(0, 0, canvas.width, canvas.height);
      g2d.fillStyle = level > 0.9 ? '#e74c3c' : level > 0.7 ? '#e07020' : '#2ecc71';
      g2d.fillRect(0, 0, Math.round(canvas.width * level), canvas.height);
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [analyser]);

  return <canvas ref={canvasRef} width={44} height={6} className="mini-meter" />;
}
